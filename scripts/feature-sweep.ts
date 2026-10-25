/**
 * Feature sweep: exercises every AI/MCP tool and every engine RPC method over
 * the real WebSocket protocol against real media (FFmpeg + Blender), renders
 * a frame for every effect / transition / text animation / blend mode and
 * checks it changed the picture, then writes a pass/fail report.
 *
 *   npx tsx scripts/feature-sweep.ts            → tests/.tmp/feature-sweep/REPORT.md
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = path.join(ROOT, "tests/.tmp");
const DIR = path.join(TMP, "feature-sweep");
process.env.MANTAGLI_HOME = path.join(TMP, "home-sweep");

const { Engine, EngineServer } = await import("../packages/engine/src/index.ts");
const { run } = await import("../packages/engine/src/util/proc.ts");
const { makeFixtures } = await import("../packages/engine/test/fixtures.ts");
const core = await import("../packages/core/src/index.ts");

// ------------------------------------------------------------------ harness

type Row = { group: string; name: string; ok: boolean; ms: number; detail: string };
const rows: Row[] = [];
let group = "";

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const r = await fn();
    const detail = typeof r === "string" ? r : "";
    rows.push({ group, name, ok: true, ms: Date.now() - t0, detail });
    process.stdout.write(`  ✓ ${name}${detail ? ` — ${detail}` : ""}\n`);
    return r;
  } catch (e) {
    const detail = (e as Error).message ?? String(e);
    rows.push({ group, name, ok: false, ms: Date.now() - t0, detail });
    process.stdout.write(`  ✗ ${name} — ${detail}\n`);
    return undefined;
  }
}

function section(name: string) {
  group = name;
  process.stdout.write(`\n${name}\n`);
}

class Rpc {
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private constructor(private ws: WebSocket) {
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as { id?: number; result?: unknown; error?: { category: string; message: string } };
      if (m.id === undefined) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(`${m.error.category}: ${m.error.message}`), m.error));
      else p.resolve(m.result);
    });
  }
  static async connect(port: number, token: string, kind = "ui"): Promise<Rpc> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${token}&client=${kind}`);
    await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
    return new Rpc(ws);
  }
  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Call an AI/MCP tool; throws with the tool's error category on failure. */
  async tool<T = any>(name: string, input: Record<string, unknown> = {}): Promise<T & { _images?: number }> {
    const r = await this.call<{ ok: boolean; data?: T; error?: { category: string; message: string }; images?: unknown[] }>("tools.call", { name, input });
    if (!r.ok) throw Object.assign(new Error(`${name}: ${r.error?.category}: ${r.error?.message}`), { category: r.error?.category });
    return Object.assign(r.data as object, { _images: r.images?.length ?? 0 }) as T & { _images?: number };
  }
  close() {
    this.ws.close();
  }
}

/** Mean absolute difference (0–255) between two images, via FFmpeg. */
async function imageDiff(a: string, b: string): Promise<number> {
  const r = await run("ffmpeg", ["-hide_banner", "-v", "info", "-i", a, "-i", b, "-filter_complex", "[0:v]format=gray[a];[1:v]format=gray[bb];[bb][a]scale2ref[b][a2];[a2][b]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-"], { timeoutMs: 60000 });
  const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(r.stderr);
  return m ? Number(m[1]) : NaN;
}

// ------------------------------------------------------------------ setup

await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });
const fx = await makeFixtures();
const gem = path.join(DIR, "gem.obj");
await writeFile(gem, "v 0 1 0\nv 1 0 0\nv 0 0 1\nv -1 0 0\nv 0 0 -1\nv 0 -1 0\nf 1 2 3\nf 1 3 4\nf 1 4 5\nf 1 5 2\nf 6 3 2\nf 6 4 3\nf 6 5 4\nf 6 2 5\n");
const font = path.join(DIR, "Bahnschrift.ttf");
// Any installed TTF serves as the "imported font" (Bahnschrift/Arial on Windows, Liberation elsewhere).
const { defaultFontFile } = await import("../packages/engine/src/render/fonts.ts");
await copyFile("C:/Windows/Fonts/bahnschrift.ttf", font).catch(async () => copyFile((await defaultFontFile(true)) ?? "C:/Windows/Fonts/arial.ttf", font));
const lut = path.join(DIR, "warm.cube");
const lutRows = ["LUT_3D_SIZE 2"];
for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lutRows.push(`${Math.min(1, r * 1.1)} ${g * 0.95} ${b * 0.8}`);
await writeFile(lut, lutRows.join("\n") + "\n");
const srt = path.join(DIR, "subs.srt");
await writeFile(srt, "1\n00:00:00,500 --> 00:00:02,000\nCut to the beat\n\n2\n00:00:02,000 --> 00:00:03,500\nRender in Blender\n");

const engine = new Engine();
await engine.init();
// The fixtures are allowed AI media folders (Settings → Media folders), wherever the checkout lives.
await engine.config.update({ aiMediaFolders: [path.dirname(fx.video), DIR] });
const server = new EngineServer(engine);
const port = await server.listen();
const ui = await Rpc.connect(port, server.token, "ui");
const mcp = await Rpc.connect(port, server.token, "mcp");
const S: Record<string, any> = {};

// ------------------------------------------------------------------ app

section("App & engine");
await step("app.info reports FFmpeg and Blender", async () => {
  const i = await ui.call("app.info");
  check(i.deps.ffmpeg && i.deps.blender, "dependency missing");
  return `FFmpeg ${i.deps.ffmpeg.version}, Blender ${i.deps.blender.version}`;
});
await step("app.fonts lists system fonts", async () => {
  const f = await ui.call<string[]>("app.fonts");
  // Windows has its font set; Linux maps the core families to Liberation/DejaVu (render/fonts.ts).
  check(f.length >= (process.platform === "win32" ? 10 : 2), `few fonts: ${f.join(", ")}`);
  return `${f.length} families`;
});
await step("app.refreshDeps", async () => void (await ui.call("app.refreshDeps")));
await step("app.updateSettings round trip", async () => {
  const before = (await ui.call("app.info")).settings;
  await ui.call("app.updateSettings", { patch: { previewScale: before.previewScale } });
});
await step("tools.list exposes every tool with a JSON schema", async () => {
  const t = await ui.call<{ name: string; inputSchema: { type: string } }[]>("tools.list");
  check(t.every((x) => x.inputSchema.type === "object"), "bad schema");
  S.toolCount = t.length;
  return `${t.length} tools`;
});

// ------------------------------------------------------------------ project

section("Project");
await step("project.create (landscape 30 fps)", async () => {
  await ui.call("project.create", { name: "Sweep", format: "landscape", fps: { num: 30, den: 1 }, parentDir: DIR });
});
await step("project_get_state / project_get_settings", async () => {
  const st = await ui.tool("project_get_state");
  const se = await ui.tool("project_get_settings");
  check(Array.isArray(st.tracks) && st.tracks.length >= 4 && se.settings.width === 1920, `unexpected state ${JSON.stringify(se.settings)}`);
});
await step("project_update_settings (background)", async () => void (await ui.tool("project_update_settings", { background: "#050508" })));
await step("capabilities lists effects/transitions/looks/templates", async () => {
  const c = await ui.tool("capabilities");
  S.caps = c;
  return `${c.effects.length} effects, ${c.transitions.length} transitions, ${c.looks.length} looks, ${c.sceneTemplates.length} 3D templates, ${c.textAnimations.length} text animations`;
});

// ------------------------------------------------------------------ media

section("Media");
await step("media_import video/audio/image/model/font/LUT", async () => {
  const r = await ui.tool("media_import", { paths: [fx.video, fx.video2, fx.music, fx.image, gem, font, lut] });
  check(r.imported.length === 7, `imported ${r.imported.length}: ${JSON.stringify(r.errors)}`);
  for (const a of r.imported) S[a.kind + (S[a.kind] ? "2" : "")] = a.id;
  return r.imported.map((a: { kind: string }) => a.kind).join(", ");
});
await step("duplicate import is detected", async () => {
  const r = await ui.tool("media_import", { paths: [fx.video] });
  check(r.duplicates.length === 1 && r.imported.length === 0, "duplicate not detected");
});
await step("media_list_assets / media_search / media_tag", async () => {
  const v = await ui.tool("media_list_assets", { kind: "video" });
  const q = await ui.tool("media_search", { query: "clip" });
  await ui.tool("media_tag", { assetId: S.video, tags: ["hero"], favorite: true });
  check(v.length === 2 && q.length >= 2, "listing/search");
});
await step("media.ensureDerived: thumbnails, filmstrip, proxy, waveform", async () => {
  await ui.call("media.ensureDerived", { assetId: S.video });
  await ui.call("media.ensureDerived", { assetId: S.audio });
  const deadline = Date.now() + 120000;
  for (;;) {
    const a = engine.project.assets.find((x) => x.id === S.video)!;
    const m = engine.project.assets.find((x) => x.id === S.audio)!;
    if (a.derived.thumbnail && a.derived.proxy && a.derived.filmstrip && m.derived.waveform) break;
    check(Date.now() < deadline, "derived media not produced");
    await new Promise((r) => setTimeout(r, 500));
  }
  const w = await ui.call("media.waveform", { assetId: S.audio });
  check(w, "no waveform");
});
await step("media_analyze (probe)", async () => void (await ui.tool("media_analyze", { assetId: S.video })));
await step("audio_analyze: tempo + beat markers", async () => {
  const b = await ui.tool("audio_analyze", { assetId: S.audio, applyMarkers: true });
  check(Math.abs(b.bpm - 120) < 3, `bpm ${b.bpm}`);
  return `${b.bpm.toFixed(1)} BPM, ${b.beatFrames.length} beats`;
});
await step("media.relink to a moved copy + media.refreshStatus", async () => {
  const moved = path.join(DIR, "moved_clip_b.mp4");
  await copyFile(fx.video2, moved);
  await ui.call("media.relink", { assetId: S.video2, path: moved });
  await ui.call("media.refreshStatus");
  check(engine.project.assets.find((a) => a.id === S.video2)!.path === moved, "not relinked");
});

// ------------------------------------------------------------------ timeline

section("Timeline editing");
const tracks = () => engine.project.tracks;
const tid = (name: string) => tracks().find((t) => t.name === name)!.id;
const clipsOf = (name: string) => tracks().find((t) => t.name === name)!.clips;
await step("timeline_add_track + timeline_update_track (role, gain)", async () => {
  const t = await ui.tool("timeline_add_track", { kind: "video", name: "FX" });
  await ui.tool("timeline_update_track", { trackId: t.trackId, volumeDb: -3, name: "FX top" });
  S.fxTrack = t.trackId;
});
await step("timeline_add_clip: media, text, colour", async () => {
  S.base = (await ui.tool("timeline_add_clip", { trackId: tid("V1"), type: "media", assetId: S.video, start: 0, duration: 150 })).clipId;
  S.text = (await ui.tool("timeline_add_clip", { trackId: tid("Titles"), type: "text", start: 0, duration: 60, text: "SWEEP" })).clipId;
  S.color = (await ui.tool("timeline_add_clip", { trackId: S.fxTrack, type: "color", start: 160, duration: 20, fill: "#ff3366" })).clipId;
  await ui.tool("timeline_add_clip", { trackId: tid("Music"), type: "media", assetId: S.audio, start: 0, duration: 360 });
});
await step("timeline_place_sequence (beat shots, look, transitions)", async () => {
  const r = await ui.tool("timeline_place_sequence", {
    trackId: tid("V2"),
    shots: [
      { assetId: S.video2, start: 150, duration: 30, look: "tealOrange" },
      { assetId: S.video, start: 180, duration: 30, sourceIn: 1, transitionIn: { type: "crossfade", duration: 8 } },
    ],
  });
  check(r.clips.length === 2, "shots");
});
await step("timeline_move / trim / split / remove (ripple)", async () => {
  const [a, b] = clipsOf("V2");
  await ui.tool("timeline_move_clip", { clipId: b!.id, start: 185 });
  await ui.tool("timeline_trim_clip", { clipId: b!.id, edge: "end", frame: 210 });
  const s = await ui.tool("timeline_split_clip", { clipId: a!.id, frame: 165 });
  await ui.tool("timeline_remove_clip", { clipIds: [s.rightId], ripple: true });
  return clipsOf("V2").map((c) => `${c.start}+${c.duration}`).join(" ");
});
await step("timeline_add_marker / timeline_add_transition / timeline_set_keyframe", async () => {
  await ui.tool("timeline_add_marker", { frame: 90, label: "Drop", kind: "section" });
  await ui.tool("timeline_add_transition", { clipId: clipsOf("V2")[1]!.id, type: "iris", duration: 10 });
  await ui.tool("timeline_set_keyframe", { clipId: S.base, property: "scale", frame: 0, value: 1 });
  await ui.tool("timeline_set_keyframe", { clipId: S.base, property: "scale", frame: 149, value: 1.2 });
});
await step("timeline_set_clip_properties (opacity, blendMode, fades)", async () => {
  await ui.tool("timeline_set_clip_properties", { clipId: S.color, props: { opacity: 0.8, blendMode: "screen", fadeIn: 4 } });
});
await step("edit_batch (atomic, one undo step)", async () => {
  const before = engine.project.markers.length;
  await ui.tool("edit_batch", { label: "two markers", commands: [{ command: "marker.add", params: { frame: 10 } }, { command: "marker.add", params: { frame: 20 } }] });
  check(engine.project.markers.length === before + 2, "markers");
  await ui.tool("project_undo");
  check(engine.project.markers.length === before, "undo batch");
  await ui.tool("project_redo");
});
await step("look_apply", async () => void (await ui.tool("look_apply", { clipIds: [clipsOf("V2")[0]!.id], look: "cyberpunk" })));
await step("timeline_set_speed_ramp (preset)", async () => {
  const r = await ui.tool("timeline_set_speed_ramp", { clipId: S.base, ramp: "montage" });
  return `duration ${r.duration}`;
});
await step("timeline_freeze_frame + reverse", async () => {
  await ui.tool("timeline_set_speed_ramp", { clipId: S.base, ramp: null });
  const f = await ui.tool("timeline_freeze_frame", { clipId: S.base, frame: 40, duration: 10 });
  const right = clipsOf("V1").find((c) => c.start === 50)!;
  await ui.tool("timeline_set_clip_properties", { clipId: right.id, props: { reverse: true } });
  check(f.clipId, "freeze");
});
await step("timeline_auto_edit to beat markers", async () => {
  const t = await ui.tool("timeline_add_track", { kind: "video", name: "Auto" });
  const r = await ui.tool("timeline_auto_edit", { trackId: t.trackId, assetIds: [S.video, S.video2], start: 240, end: 360, every: 2, transition: { type: "flash", duration: 4 }, pulse: 0.05 });
  await ui.tool("timeline_update_track", { trackId: t.trackId, hidden: true });
  return `${r.shots} shots`;
});

// ------------------------------------------------------------------ effects etc. (rendered)

section("Rendered features (every effect, transition, text animation, blend mode)");
/** Isolated scene for visual checks: footage on V1 frames 400–460, test layer on top. */
const lab = await step("lab clip for visual checks", async () => {
  const c = await ui.tool("timeline_add_clip", { trackId: tid("V1"), type: "media", assetId: S.image, start: 400, duration: 60 });
  await ui.tool("timeline_set_clip_properties", { clipId: c.clipId, props: { transform: { fit: "stretch" } } });
  S.lab = c.clipId;
  S.plain = (await ui.call("render.still", { frame: 430, scale: 0.25 })).path;
  return "ready"; // (a void step result would skip every rendered-feature check below)
});
if (lab !== undefined) {
  for (const e of core.EFFECTS) {
    await step(`effect: ${e.type}`, async () => {
      const params: Record<string, unknown> =
        e.type === "lut" ? { assetId: S.lut } : e.type === "shake" ? { amount: 4 } : e.type === "glitch" ? { amount: 1, density: 1 } : e.type === "chromaKey" ? { color: "#ffffff", similarity: 0.3 } : e.type === "mask" ? { shape: "ellipse" } : e.type === "exposure" ? { stops: 1 } : e.type === "basicColor" ? { saturation: 0 } : e.type === "temperature" ? { warmth: 0.8 } : e.type === "tone" ? { shadows: 0.8 } : e.type === "splitTone" ? { shadowAmount: 1, highlightAmount: 1 } : e.type === "beatPulse" ? { zoom: 0.3, on: "beats" } : {};
      if (e.type === "beatPulse") await ui.tool("timeline_add_marker", { frame: 430, kind: "beat" });
      const r = await ui.tool("effect_add", { clipId: S.lab, type: e.type, params });
      if (e.type === "grain") await ui.tool("effect_update", { clipId: S.lab, effectId: r.effectId, params: { amount: 40 } });
      const still = (await ui.call("render.still", { frame: 430, scale: 0.25 })).path;
      const d = await imageDiff(still, S.plain);
      await ui.tool("effect_remove", { clipId: S.lab, effectId: r.effectId });
      check(d > 0.3, `picture unchanged (diff ${d.toFixed(2)})`);
      return `Δ ${d.toFixed(1)}`;
    });
  }
  for (const t of core.TRANSITIONS) {
    await step(`transition: ${t.type}`, async () => {
      const prev = (await ui.tool("timeline_add_clip", { trackId: tid("V1"), type: "color", start: 470, duration: 30, fill: "#2050ff" })).clipId;
      const inc = (await ui.tool("timeline_add_clip", { trackId: tid("V1"), type: "media", assetId: S.image, start: 500, duration: 30 })).clipId;
      await ui.tool("timeline_add_transition", { clipId: inc, type: t.type, duration: 12 });
      const mid = (await ui.call("render.still", { frame: 505, scale: 0.25 })).path;
      const end = (await ui.call("render.still", { frame: 520, scale: 0.25 })).path;
      await ui.tool("timeline_remove_clip", { clipIds: [prev, inc] });
      const d = await imageDiff(mid, end);
      check(d > 0.5, `no visible transition (diff ${d.toFixed(2)})`);
      return `Δ mid/end ${d.toFixed(1)}`;
    });
  }
  for (const anim of core.TEXT_ANIMATIONS.filter((a) => a !== "none")) {
    await step(`text animation: ${anim}`, async () => {
      const c = await ui.tool("timeline_add_clip", { trackId: tid("Titles"), type: "text", start: 540, duration: 40, text: "MANTAGLI\nSWEEP TEST", style: { fontSize: 140 }, animation: { in: anim, out: anim, duration: 12 } });
      const early = (await ui.call("render.still", { frame: 543, scale: 0.25 })).path;
      const held = (await ui.call("render.still", { frame: 560, scale: 0.25 })).path;
      await ui.tool("timeline_remove_clip", { clipIds: [c.clipId] });
      const d = await imageDiff(early, held);
      check(d > 0.2, `animation not visible (diff ${d.toFixed(2)})`);
      return `Δ ${d.toFixed(2)}`;
    });
  }
  for (const mode of core.BLEND_MODES.filter((m) => m !== "normal")) {
    await step(`blend mode: ${mode}`, async () => {
      const c = await ui.tool("timeline_add_clip", { trackId: S.fxTrack, type: "color", start: 400, duration: 60, fill: "#808040" });
      await ui.tool("timeline_set_clip_properties", { clipId: c.clipId, props: { blendMode: "normal" } });
      const normal = (await ui.call("render.still", { frame: 430, scale: 0.25 })).path;
      await ui.tool("timeline_set_clip_properties", { clipId: c.clipId, props: { blendMode: mode } });
      const blended = (await ui.call("render.still", { frame: 430, scale: 0.25 })).path;
      await ui.tool("timeline_remove_clip", { clipIds: [c.clipId] });
      const d = await imageDiff(normal, blended);
      check(d > 0.5, `same as normal (diff ${d.toFixed(2)})`);
      return `Δ ${d.toFixed(1)}`;
    });
  }
}

// ------------------------------------------------------------------ 3D

section("3D (Blender)");
for (const tpl of core.SCENE_TEMPLATES) {
  await step(`3D template: ${tpl.id} renders`, async () => {
    const sc = await ui.tool("scene_create", { name: `T ${tpl.id}`, template: tpl.id, durationFrames: 24, text: "MANTAGLI", ...(tpl.id === "productTurntable" ? { modelAssetId: S.model } : {}) });
    const p = await ui.tool("scene_preview", { sceneId: sc.sceneId, frame: 12 });
    check(p._images === 1, "no preview image");
    S[`scene_${tpl.id}`] = sc.sceneId;
  });
}
await step("scene_add_object / text / camera / light / material / animate / update", async () => {
  const id = S.scene_empty;
  const cube = await ui.tool("scene_add_object", { sceneId: id, kind: "mesh", primitive: "torus", name: "Ring" });
  const gemObj = await ui.tool("scene_add_object", { sceneId: id, kind: "model", modelAssetId: S.model, name: "Gem" });
  await ui.tool("scene_add_text", { sceneId: id, text: "3D", size: 0.8, location: [0, 0, 1.4] });
  const cam = await ui.tool("scene_add_camera", { sceneId: id, location: [0, -7, 1.5], rotation: [80, 0, 0], focalLength: 50 });
  await ui.tool("scene_add_light", { sceneId: id, type: "area", location: [3, -3, 4], rotation: [45, 0, 45] });
  await ui.tool("scene_set_material", { sceneId: id, objectId: cube.objectId, preset: "chrome" });
  await ui.tool("scene_set_material", { sceneId: id, objectId: gemObj.objectId, preset: "gold" });
  await ui.tool("scene_animate", { sceneId: id, objectId: cube.objectId, property: "rotation", keyframes: [{ frame: 0, value: [0, 0, 0] }, { frame: 23, value: [0, 0, 180] }] });
  await ui.tool("scene_update_object", { sceneId: id, objectId: gemObj.objectId, patch: { location: [1.8, 0, 0] } });
  await ui.tool("scene_set_render_settings", { sceneId: id, activeCameraId: cam.objectId });
  const p = await ui.tool("scene_preview", { sceneId: id, frame: 10 });
  check(p._images === 1, "preview");
});
await step("scene_camera_move (orbit, snap stops) + media plane + scatter", async () => {
  const id = S.scene_empty;
  const cam = await ui.tool("scene_add_camera", { sceneId: id, name: "Orbit cam", location: [0, -7, 1.5], shake: 0.3 });
  const mv = await ui.tool("scene_camera_move", { sceneId: id, cameraId: cam.objectId, move: "orbit", arc: 120, distance: 7, stops: [4, 12], stepFrames: 6, easing: "expoOut" });
  check(mv.keyframes === 4, `progress keys ${mv.keyframes}`);
  await ui.tool("scene_add_object", { sceneId: id, kind: "media", name: "Screen", mediaAssetId: S.image, mediaWidth: 1.5, location: [0, 1, 1.5] });
  await ui.tool("scene_add_object", { sceneId: id, kind: "scatter", name: "Coins", primitive: "coin", scatterCount: 300, material: "gold" });
  const p = await ui.tool("scene_preview", { sceneId: id, frame: 14 });
  check(p._images === 1, "preview");
  return `${mv.points} path points`;
});
await step("scatter burst: add (scatterBurst), patch, preview, unset", async () => {
  const id = S.scene_empty;
  const b = await ui.tool("scene_add_object", { sceneId: id, kind: "scatter", name: "Fountain", primitive: "coin", scatterCount: 60, scatterDistribution: "box", scatterArea: [0.2, 0.2, 0.05], location: [0, 0, 0.5], material: "gold", scatterBurst: { frame: 2, speed: 5 } });
  await ui.tool("scene_update_object", { sceneId: id, objectId: b.objectId, patch: { scatter: { burst: { frame: 2, speed: 6, bounce: 0.4 } } } });
  const obj = () => engine.project.scenes.find((x) => x.id === id)!.objects.find((o) => o.id === b.objectId)!;
  check(obj().scatter!.count === 60 && obj().scatter!.burst!.speed === 6 && obj().scatter!.burst!.gravity === 9.81, JSON.stringify(obj().scatter));
  const p = await ui.tool("scene_preview", { sceneId: id, frame: 10 });
  check(p._images === 1, "preview");
  await ui.tool("scene_update_object", { sceneId: id, objectId: b.objectId, unset: ["scatter.burst"] });
  check(!obj().scatter!.burst, "burst not removed");
});
await step("scene_bake (draft) -> video asset", async () => {
  const sc = await ui.tool("scene_create", { name: "Bake", template: "particleBackdrop", durationFrames: 8 });
  const b = await ui.tool("scene_bake", { sceneId: sc.sceneId, quality: "draft" });
  check(!!b.assetId && b.duration > 0.2, "no baked asset");
  return `${b.duration.toFixed(2)} s video`;
});
await step("Cycles GPU preset renders (render.scene + render.sceneCache)", async () => {
  await ui.tool("scene_set_render_settings", { sceneId: S.scene_chromeTitle, preset: "cyclesPreview", render: { samples: 8 } });
  await ui.call("render.scene", { sceneId: S.scene_chromeTitle, quality: "draft", scale: 0.2, frames: [5] });
  const c = await ui.call("render.sceneCache", { sceneId: S.scene_chromeTitle, quality: "draft", scale: 0.2 });
  check(c.frames >= 1, "no cached frame");
  return `Cycles device ${engine.deps.blender?.cyclesDevice}`;
});
await step("3D scene clip on the timeline renders in the exact frame", async () => {
  const t = await ui.tool("timeline_add_track", { kind: "scene", name: "3D" });
  await ui.tool("timeline_add_clip", { trackId: t.trackId, type: "scene", sceneId: S.scene_neonFlythrough, start: 600, duration: 24 });
  const p = await ui.tool("preview_render", { frames: [612], scale: 0.25 });
  check(p._images === 1, "no image");
});

// ------------------------------------------------------------------ preview, audio, captions, interchange

section("Preview, audio, captions, interchange");
await step("sfx_generate: riser ends on the anchor, whoosh on the SFX track", async () => {
  const r = await ui.tool("sfx_generate", { kind: "riser", anchorFrame: 120, duration: 1 });
  check(r.start === 90 && r.frames === 30, `riser placed at ${r.start}+${r.frames}`);
  const w = await ui.tool("sfx_generate", { kind: "whoosh", anchorFrame: 200 });
  check(!!w.clipId, "no whoosh clip");
  return `riser 90-120, whoosh at ${w.start}`;
});
await step("music_generate: exact length, beat grid and sections on the asset", async () => {
  const m = await ui.tool("music_generate", { style: "techno", mood: "tense", duration: 8, seed: 3, place: false });
  const a = Object.values(await ui.tool("media_list_assets", {})).find((x: { id: string }) => x.id === m.assetId);
  check(Math.abs(a.meta.duration - 8) < 0.05, `length ${a.meta.duration}`);
  check(m.bpm === 128 && a.bpm === 128, `bpm ${m.bpm} / asset ${a.bpm}`);
  check(m.sections.some((x: { label: string }) => x.label === "drop"), JSON.stringify(m.sections));
  return `${m.bpm} BPM, ${m.sections.map((x: { label: string }) => x.label).join("/")}`;
});
await step("voice_providers + voice_narrate (captions) + voice_regenerate", async () => {
  const pv = await ui.tool("voice_providers", {});
  const local = pv.providers.find((x: { kind: string; available: boolean }) => x.kind === "local" && x.available);
  if (!local) return `skipped: no local TTS engine (${pv.providers.map((x: { id: string; available: boolean }) => `${x.id}:${x.available}`).join(" ")})`;
  const n = await ui.tool("voice_narrate", { segments: [{ text: "Cut to the beat." }, { text: "Render in Blender." }], start: 1300, captions: true, duck: false });
  check(n.segments.length === 2 && n.segments.every((x: { captions: number }) => x.captions >= 1), JSON.stringify(n).slice(0, 300));
  // Re-voice the last line (a longer take must not run into the next segment).
  const r = await ui.tool("voice_regenerate", { clipId: n.segments[1].clipId, text: "Then render it in Blender." });
  check(!!r.clipId && r.start === n.segments[1].start && r.captions >= 1, JSON.stringify(r).slice(0, 300));
  return `${n.provider}: ${n.segments.map((x: { frames: number }) => x.frames).join("+")} frames; re-voiced ${r.previousFrames} -> ${r.frames}`;
});
await step("sfx_suggest + audio_meter", async () => {
  const sd = await ui.tool("sfx_suggest", {});
  const m = await ui.tool("audio_meter", { start: 0, end: 300 });
  check(Number.isFinite(m.integratedLufs) && Number.isFinite(m.truePeakDb), JSON.stringify(m).slice(0, 300));
  check(m.truePeakDb < 0, `true peak ${m.truePeakDb}`);
  return `${sd.suggestions.length} suggestions; ${m.integratedLufs} LUFS, ${m.truePeakDb} dBTP`;
});
await step("look_save + look_apply (saved look)", async () => {
  await ui.tool("effect_add", { clipId: S.lab, type: "scanlines", params: { amount: 0.4 } });
  const l = await ui.tool("look_save", { clipId: S.lab, label: "Sweep look" });
  const c = await ui.tool("timeline_add_clip", { trackId: tid("V2"), type: "color", start: 900, duration: 10, fill: "#808080" });
  await ui.tool("look_apply", { clipIds: [c.clipId], look: l.lookId });
  const st = await ui.tool("project_get_state", {});
  check(JSON.stringify(st).includes("scanlines"), "saved look not applied");
  return l.lookId;
});
await step("transition_apply_preset + transition_save_preset", async () => {
  const a = await ui.tool("timeline_add_clip", { trackId: tid("V2"), type: "color", start: 910, duration: 30, fill: "#204060" });
  const b = await ui.tool("timeline_add_clip", { trackId: tid("V2"), type: "color", start: 940, duration: 8, fill: "#602040" });
  const r = await ui.tool("transition_apply_preset", { clipIds: [a.clipId, b.clipId], preset: "punchThrough" });
  check(r.applied === 2 && r.shortened.length === 1 && r.shortened[0] === b.clipId, JSON.stringify(r));
  const saved = await ui.tool("transition_save_preset", { clipId: a.clipId, label: "Sweep punch" });
  const st = await ui.tool("project_get_state", {});
  check(st.savedTransitionPresets?.some((t: { id: string }) => t.id === saved.presetId), "saved preset missing from project state");
  await ui.tool("transition_apply_preset", { clipIds: [b.clipId], preset: saved.presetId });
  return `${saved.presetId}; short clip got ${clipsOf("V2").find((c) => c.id === b.clipId)?.transitionIn?.duration}f`;
});
await step("preview_render returns real frames as images", async () => {
  const p = await ui.tool("preview_render", { frames: [10, 170, 430], scale: 0.3 });
  check(p._images === 3, "images");
});
await step("preview_render_range + render.range (draft MP4)", async () => {
  const r = await ui.tool("preview_render_range", { start: 0, end: 60 });
  const r2 = await ui.call("render.range", { start: 150, end: 200, scale: 0.25 });
  check(r.path && r2.path, "no path");
});
await step("audio_set_ducking + export_set_settings (loudness)", async () => {
  await ui.tool("timeline_update_track", { trackId: tid("SFX"), name: "Voice" });
  await ui.call("project.dispatch", { name: "track.update", params: { trackId: tid("Voice"), role: "dialogue" } });
  await ui.tool("timeline_add_clip", { trackId: tid("Voice"), type: "media", assetId: S.audio, start: 60, duration: 30 });
  const m = await ui.tool("audio_set_ducking", { enabled: true, amountDb: 10 });
  const e = await ui.tool("export_set_settings", { loudnessLufs: -14, crf: 26, encoderPreset: "veryfast" });
  check(m.ducking.enabled && e.loudnessLufs === -14, "settings");
});
await step("captions_import (kinetic) + captions_export", async () => {
  const r = await ui.tool("captions_import", { path: srt, style: "kinetic" });
  const out = await ui.tool("captions_export", { trackId: r.trackId });
  const text = await readFile(out.path, "utf8");
  check(r.clips === 2 && text.includes("Render in Blender"), "captions");
  S.captionsTrack = r.trackId;
});
await step("interchange.importCaptions / exportCaptions (RPC)", async () => {
  const r = await ui.call("interchange.importCaptions", { path: srt, style: "boxed", position: "top" });
  await ui.call("interchange.exportCaptions", { trackId: r.trackId, path: path.join(DIR, "boxed.srt") });
  await ui.tool("timeline_update_track", { trackId: r.trackId, hidden: true });
});
await step("timeline_export_otio + timeline_import_otio round trip", async () => {
  const e = await ui.tool("timeline_export_otio", {});
  const before = tracks().length;
  const i = await ui.tool("timeline_import_otio", { path: e.path });
  check(tracks().length === before + i.tracks && i.warnings.length === 0, JSON.stringify(i.warnings));
  await ui.tool("project_undo");
  return `${e.clips} clips`;
});
await step("interchange.exportOtio (RPC)", async () => void (await ui.call("interchange.exportOtio", { path: path.join(DIR, "sweep.otio") })));

// ------------------------------------------------------------------ project safety

section("Undo, history, persistence");
await step("project.history / project.oplog / project.save / project.backups", async () => {
  const h = await ui.call("project.history");
  const log = await ui.call<unknown[]>("project.oplog");
  await ui.call("project.save");
  const b = await ui.call<string[]>("project.backups");
  check(h.undo.length > 10 && log.length > 10 && b.length >= 1, "history/oplog/backups");
  return `${h.undo.length} undo steps, ${b.length} backup(s)`;
});
await step("project.dispatch / project.transaction (UI path)", async () => {
  await ui.call("project.transaction", { label: "two cues", commands: [{ name: "marker.add", params: { frame: 33 } }, { name: "marker.add", params: { frame: 34, label: "x" } }] });
  await ui.call("project.undo");
  await ui.call("project.redo");
});
await step("undo history survives close + reopen", async () => {
  const dir = engine.requireSession().dir;
  const steps = (await ui.call("project.history")).undo.length;
  await ui.call("project.close");
  await ui.call("project.open", { path: dir });
  const after = (await ui.call("project.history")).undo.length;
  check(after === steps, `${after} vs ${steps}`);
  return `${after} steps restored`;
});
await step("project_save / project_create / project_open (tools)", async () => {
  const dir = engine.requireSession().dir;
  await ui.tool("project_save");
  await ui.call("app.updateSettings", { patch: { projectsDir: DIR } });
  const c = await ui.tool("project_create", { name: "Sweep scratch", format: "square", fps: "25" });
  check(engine.project.settings.width === 1080 && engine.project.settings.height === 1080, "square project");
  await ui.tool("project_open", { path: dir });
  check(engine.project.name === "Sweep", "reopened");
  return `created ${path.basename(c.dir ?? "")}`;
});
await step("project_validate / project_validate_render", async () => {
  const v = await ui.tool("project_validate");
  const r = await ui.tool("project_validate_render", { preset: "landscape1080" });
  check(r.ok, JSON.stringify(r.issues));
  return `${(v.issues ?? v).length ?? 0} validation notes`;
});

// ------------------------------------------------------------------ export

section("Export");
await step("export_render (waits ≤ 45 s) + export_status polling → verified MP4", async () => {
  await ui.call("project.dispatch", { name: "track.update", params: { trackId: tid("Auto"), hidden: false } });
  let r = await ui.tool("export_render", { preset: "landscape1080", outPath: path.join(DIR, "sweep_export.mp4"), wait: true });
  while (r.status !== "done") {
    check(r.status === "running" || r.status === "queued", `status ${r.status}`);
    const j = await ui.tool("export_status", { jobId: r.jobId, waitSeconds: 40 });
    check(j.status !== "failed", j.error?.message);
    r = j.status === "done" ? { status: "done", ...j.result } : { ...j, jobId: r.jobId };
  }
  check(r.check.ok, JSON.stringify(r.check));
  return `${r.check.width}×${r.check.height}, ${r.check.duration.toFixed(2)} s, ${r.check.videoCodec}/${r.check.audioCodec ?? "?"}`;
});
await step("render.export (RPC) + jobs.list + job_cancel", async () => {
  const job = await ui.call("render.export", { preset: "landscape1080", outPath: path.join(DIR, "cancelled.mp4") });
  const list = await ui.call<{ id: string }[]>("jobs.list");
  check(list.some((j) => j.id === job.id), "job missing");
  const c = await ui.tool("job_cancel", { jobId: job.id });
  const st = await ui.tool("export_status", { jobId: job.id, waitSeconds: 20 });
  check(c.cancelled && st.status === "cancelled", `cancel → ${st.status}`);
});

// ------------------------------------------------------------------ AI layer

section("AI layer");
await step("plan_save records a shot plan", async () => void (await ui.tool("plan_save", { brief: "sweep", summary: "test", status: "done", shots: [{ index: 0, description: "x", startFrame: 0, durationFrames: 10 }] })));
await step("MCP clients cannot import outside the media folders", async () => {
  try {
    await mcp.tool("media_import", { paths: [process.platform === "win32" ? "C:/Windows/win.ini" : "/etc/hostname"] });
  } catch (e) {
    check((e as { category?: string }).category === "permission_denied" || /permission|outside/i.test(String(e)), String(e));
    return "permission_denied";
  }
  throw new Error("import was allowed");
});
await step("Director without an API key fails cleanly (ai.setApiKey / ai.start / ai.runs / ai.reset)", async () => {
  const had = process.env.ANTHROPIC_API_KEY;
  await ui.call("ai.setApiKey", { key: "" });
  let msg = "";
  try {
    const r = await ui.call("ai.start", { brief: "make a montage" });
    // A run may start and then fail asynchronously; wait for it to settle.
    for (let i = 0; i < 40; i++) {
      const runs = await ui.call<{ id: string; status: string; events: { type: string; message?: string }[] }[]>("ai.runs");
      const me = runs.find((x) => x.id === r.id);
      if (me && me.status !== "running") {
        msg = `${me.status}: ${me.events.filter((e) => e.type === "error").map((e) => e.message).join(" ")}`;
        break;
      }
      await new Promise((res) => setTimeout(res, 250));
    }
  } catch (e) {
    msg = String((e as Error).message);
  }
  await ui.call("ai.reset");
  if (had) process.env.ANTHROPIC_API_KEY = had;
  check(/API key is missing/.test(msg), `unexpected: ${msg}`);
  return msg.slice(0, 80);
});

// ------------------------------------------------------------------ report

ui.close();
mcp.close();
await engine.closeProject();
const toolsCalled = new Set<string>();
const sweepSrc = await readFile(new URL(import.meta.url), "utf8");
for (const m of sweepSrc.matchAll(/\.tool(?:<[^>]*>)?\("([a-z_]+)"/g)) toolsCalled.add(m[1]!);
const allTools = (await import("../packages/engine/src/ai/tools.ts")).TOOLS.map((t) => t.name);
const notCovered = allTools.filter((t) => !toolsCalled.has(t));
const pass = rows.filter((r) => r.ok).length;
const lines = [
  `# Mantagli feature sweep`,
  ``,
  `Run: ${new Date().toISOString()} · ${pass}/${rows.length} passed · ${allTools.length - notCovered.length}/${allTools.length} tools exercised${notCovered.length ? ` (not called: ${notCovered.join(", ")})` : ""}`,
  ``,
  `| Area | Check | Result | Time | Detail |`,
  `|---|---|---|---|---|`,
  ...rows.map((r) => `| ${r.group} | ${r.name} | ${r.ok ? "✅" : "❌"} | ${(r.ms / 1000).toFixed(1)} s | ${r.detail.replace(/\|/g, "/").slice(0, 160)} |`),
];
await writeFile(path.join(DIR, "REPORT.md"), lines.join("\n") + "\n");
process.stdout.write(`\n${pass}/${rows.length} passed; tools not called: ${notCovered.join(", ") || "none"}\nReport: ${path.join(DIR, "REPORT.md")}\n`);
await server.close?.();
process.exit(pass === rows.length ? 0 : 1);
