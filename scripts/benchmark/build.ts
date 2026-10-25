/**
 * Reference benchmark montage "NEON QUEST" (see REFERENCE_VIDEO_ANALYSIS.md),
 * built only through Mantagli's AI tool layer (the tools the Director and MCP
 * clients use). 1080x1920, 30 fps, 24 s, original score and sound effects.
 *
 *   node scripts/benchmark/score.mjs <root>/media/neon_quest_score.wav   (root: see ROOT below)
 *   npx tsx scripts/benchmark/build.ts build     # project, analysis, scenes, bake, timeline
 *   npx tsx scripts/benchmark/build.ts stills    # review frames -> <root>/review
 *   npx tsx scripts/benchmark/build.ts export    # final export + verification
 *
 * Shot plan (frames at 30 fps; the score drops at 4 s and 14 s):
 *   0-120    arcadePortal: push in, fly into the cabinet screen (portal)
 *   120-300  treasure hoard (baked; the same video played on the arcade screen)
 *   300-420  turntable stations, snapping on beat markers   (whip pan in)
 *   420-540  synthwave horizon, level select               (glitch cut on drop 2)
 *   540-720  metal title end card                           (zoom through)
 * A CRT adjustment layer finishes the whole frame; a beat-pulse adjustment
 * punches the drop-2 section.
 */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

// MANTAGLI_BENCH_ROOT moves the project/renders (default: D: on the dev machine, tests/.tmp elsewhere).
const ROOT = process.env.MANTAGLI_BENCH_ROOT ?? (process.platform === "win32" ? "D:/MantagliBenchmark" : path.resolve(import.meta.dirname, "../../tests/.tmp/benchmark"));
const MEDIA = path.join(ROOT, "media");
process.env.MANTAGLI_HOME = path.join(ROOT, "home");
const { Engine, executeTool } = await import("../../packages/engine/src/index.ts");
const stage = process.argv[2] ?? "build";

const engine = new Engine();
await engine.init();
const tool = async (name: string, input: Record<string, unknown>) => {
  const r = await executeTool({ engine, source: "user" }, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.data as any;
};
const PROJECT = path.join(ROOT, "Neon Quest.mantagli");
const TOTAL = 720;
// Without Bahnschrift (non-Windows) FFmpeg asks fontconfig for the closest match.
const FONT = process.env.MANTAGLI_BENCH_FONT ?? "Bahnschrift";

if (stage === "build") {
  await mkdir(ROOT, { recursive: true });
  await engine.createProject({ name: "Neon Quest", format: "vertical", parentDir: ROOT }).catch(async () => {
    await engine.openProject(PROJECT, { force: true });
  });
  const s = engine.requireSession();
  if (s.project.tracks.some((t) => t.clips.length)) throw new Error(`Project already built: delete ${PROJECT} to rebuild`);

  // ---- music and analysis
  await engine.importMedia([path.join(MEDIA, "neon_quest_score.wav")]);
  const score = s.project.assets.find((a) => a.name === "neon_quest_score.wav")!;
  const music = s.project.tracks.find((t) => t.role === "music")!.id;
  await tool("timeline_add_clip", { trackId: music, type: "media", assetId: score.id, start: 0, duration: TOTAL });
  const beats = await tool("audio_analyze", { assetId: score.id });
  console.log(`score: ${beats.bpm} BPM, ${beats.beatFrames.length} beats, sections ${JSON.stringify(beats.sections)}`);
  const drops = (beats.sections as { frame: number; label: string }[]).filter((x) => x.label === "drop").map((x) => x.frame);
  console.log("drops at frames", drops);

  // ---- 3D scenes (quality: EEVEE, 32 samples, motion blur)
  const quality = { render: { engine: "eevee", samples: 32, motionBlur: true, shutter: 0.5, bloom: true } };
  const treasure = await tool("scene_create", { name: "Treasure", template: "treasureHoard", durationFrames: 300 });
  await tool("scene_set_render_settings", { sceneId: treasure.sceneId, ...quality });
  console.log("baking the treasure scene (final quality, 300 frames)...");
  const baked = await tool("scene_bake", { sceneId: treasure.sceneId });
  const portal = await tool("scene_create", { name: "Arcade", template: "arcadePortal", durationFrames: 120, mediaAssetId: baked.assetId });
  // Station snaps on the detected beats inside 300-420, every second beat.
  const stationBeats = (beats.beatFrames as number[]).filter((f) => f > 300 && f < 410);
  const stops = stationBeats.filter((_, i) => i % 2 === 1).slice(0, 3).map((f) => f - 300);
  console.log("turntable stops (scene frames)", stops);
  const stations = await tool("scene_create", { name: "Stations", template: "turntableStage", durationFrames: 120, count: 4, stops });
  const horizon = await tool("scene_create", { name: "Horizon", template: "synthwaveHorizon", durationFrames: 120 });
  const title = await tool("scene_create", { name: "End title", template: "metalTitle", durationFrames: 180, text: "NEON QUEST" });
  for (const sc of [portal, stations, horizon, title]) await tool("scene_set_render_settings", { sceneId: sc.sceneId, ...quality });

  // ---- picture track
  const v1 = s.project.tracks.find((t) => t.name === "V1")!.id;
  const shot = (input: Record<string, unknown>) => tool("timeline_add_clip", { trackId: v1, mode: "error", ...input });
  await shot({ type: "scene", sceneId: portal.sceneId, start: 0, duration: 120, name: "Arcade portal" });
  // Portal hand-off: the arcade screen played the bake from 0 s, so continue it at 4 s.
  await shot({ type: "media", assetId: baked.assetId, start: 120, duration: 180, sourceIn: 4, name: "Treasure" });
  const st = await shot({ type: "scene", sceneId: stations.sceneId, start: 300, duration: 120, name: "Stations" });
  const hz = await shot({ type: "scene", sceneId: horizon.sceneId, start: 420, duration: 120, name: "Horizon" });
  const et = await shot({ type: "scene", sceneId: title.sceneId, start: 540, duration: 180, name: "End title" });
  await tool("timeline_add_transition", { clipId: st.clipId, type: "whipLeft", duration: 12 });
  await tool("timeline_add_transition", { clipId: hz.clipId, type: "glitchCut", duration: 8 });
  await tool("timeline_add_transition", { clipId: et.clipId, type: "zoomThrough", duration: 12 });
  await tool("timeline_set_clip_properties", { clipId: et.clipId, props: { fadeOut: 30 } });

  // ---- titles
  const titles = s.project.tracks.find((t) => t.name === "Titles")!.id;
  // Subtitles overlap the titles in time, so they get their own text track.
  const subs = (await tool("timeline_add_track", { kind: "text", name: "Subtitles", index: 1 })).trackId;
  const text = async (t: string, start: number, duration: number, y: number, size: number, color: string, anim: Record<string, unknown>, extra: Record<string, unknown> = {}, trackId = titles) =>
    tool("timeline_add_clip", {
      trackId,
      mode: "error",
      type: "text",
      text: t,
      start,
      duration,
      transform: { y },
      style: { fontFamily: FONT, bold: true, fontSize: size, color, shadow: true, ...extra },
      animation: anim,
    });
  await text("PRESS START", 24, 84, 640, 64, "#1de9b6", { in: "scramble", out: "fade", duration: 12 });
  const main = await text("NEON QUEST", 122, 170, -420, 150, "#ffffff", { in: "scramble", out: "scramble", duration: 14 }, { strokeWidth: 3, strokeColor: "#2a0f5a" });
  await tool("effect_add", { clipId: main.clipId, type: "glitch", params: { amount: 0.6, density: 0.12, seed: 3 } });
  await text("SEVENTH EDITION", 136, 156, -280, 56, "#ffc356", { in: "typewriter", out: "fade", duration: 16 }, {}, subs);
  const names = ["WORKSHOPS", "CTF BATTLES", "TREASURE HUNT", "PRIZES"];
  const edges = [300, ...stops.map((f) => 300 + f), 420];
  for (let i = 0; i < 4; i++) {
    const a = edges[i]!;
    const b = edges[i + 1]!;
    if (b - a < 8) continue;
    await text(names[i]!, a + (i === 0 ? 6 : 2), b - a - (i === 0 ? 6 : 2), -560, 110, "#f4f4f6", { in: "scramble", out: "none", duration: 8 }, { strokeWidth: 2, strokeColor: "#062b2a" });
  }
  await text("SELECT YOUR LEVEL", 428, 60, -420, 72, "#1de9b6", { in: "words", out: "fade", duration: 10 });
  const lvl = await text("LEVEL 7", 488, 52, -380, 160, "#ffc356", { in: "scramble", out: "fade", duration: 10 }, { strokeWidth: 3, strokeColor: "#3a0a2a" });
  await tool("effect_add", { clipId: lvl.clipId, type: "glitch", params: { amount: 0.8, density: 0.35, seed: 9 } });
  await text("14-15 NOVEMBER  ·  TUNIS", 610, 100, 560, 54, "#ffffff", { in: "typewriter", out: "fade", duration: 18 });

  // ---- whole-frame finish: CRT look; beat pulse in drop 2
  const adj = await tool("timeline_add_track", { kind: "video", name: "Adjust", index: 0 });
  const crt = await tool("timeline_add_clip", { trackId: adj.trackId, type: "adjustment", start: 0, duration: TOTAL, name: "CRT finish" });
  await tool("look_apply", { clipIds: [crt.clipId], look: "crtMonitor" });
  const adj2 = await tool("timeline_add_track", { kind: "video", name: "Pulse", index: 1 });
  const pulse = await tool("timeline_add_clip", { trackId: adj2.trackId, type: "adjustment", start: 420, duration: 120, name: "Beat pulse" });
  await tool("effect_add", { clipId: pulse.clipId, type: "beatPulse", params: { zoom: 0.035, decay: 7, on: "downbeats" } });
  await tool("effect_add", { clipId: pulse.clipId, type: "basicColor", params: { contrast: 1.0 } });

  // ---- sound design (anchored to the visual events)
  await tool("sfx_generate", { kind: "whoosh", anchorFrame: 306, gainDb: -4 });
  await tool("sfx_generate", { kind: "glitch", anchorFrame: 420, gainDb: -8, seed: 4 });
  await tool("sfx_generate", { kind: "whoosh", anchorFrame: 546, gainDb: -3, pitch: 0.7, seed: 2 });
  for (const f of edges.slice(1, -1)) await tool("sfx_generate", { kind: "blip", anchorFrame: f, gainDb: -12, pitch: 1.2 });
  await tool("sfx_generate", { kind: "blip", anchorFrame: 24, gainDb: -12 });
  await tool("sfx_generate", { kind: "hit", anchorFrame: 488, gainDb: -6 });
  await tool("export_set_settings", { preset: "reel1080", loudnessLufs: -14 });
  await tool("project_save", {});
  console.log("timeline built");
}

if (stage === "stills") {
  await engine.openProject(PROJECT, { force: true });
  const out = path.join(ROOT, "review");
  await mkdir(out, { recursive: true });
  const frames = (process.argv[3] ?? "10,60,110,119,120,121,160,250,306,330,365,400,424,470,500,546,560,640,700").split(",").map(Number);
  for (const f of frames) {
    const r = await engine.renderStill(f, { scale: 0.5, quality: "final" });
    await copyFile(r.path, path.join(out, `f${String(f).padStart(3, "0")}.png`));
    console.log("still", f);
  }
}

if (stage === "export") {
  await engine.openProject(PROJECT, { force: true });
  // AI/MCP exports stay inside the project folder (exports/); copied out afterwards.
  const t0 = Date.now();
  const r = await tool("export_render", { preset: "reel1080" });
  let st = r;
  while (!["done", "failed", "cancelled"].includes(st.status)) {
    st = await tool("export_status", { jobId: r.jobId, waitSeconds: 40 });
    console.log(st.status, st.progress ?? "", st.message ?? "");
  }
  console.log(JSON.stringify(st, null, 1), `${((Date.now() - t0) / 60000).toFixed(1)} min`);
}
await engine.closeProject();
