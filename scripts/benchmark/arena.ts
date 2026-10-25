/**
 * End-to-end benchmark "ARENA": a 22 s vertical teaser built only through Mantagli's tool layer
 * (what the AI Director and MCP clients use) and rendered through the real pipeline:
 * generated score → shots timed to its sections → 3D (synthwave horizon, chrome title, metal end
 * card) + 2D typography → transitions on the drop → voice-over with captions → suggested sound
 * design → CRT finish + beat pulse → loudness check → export → verification → review stills.
 *
 *   npx tsx scripts/benchmark/arena.ts            # build + export (+ review sheet)
 *   MANTAGLI_ARENA_SIZE=1080x1920 ...             # full size (dev machine with a GPU)
 *
 * Output (default tests/.tmp/arena, or MANTAGLI_BENCH_ROOT): the project, exports/arena.mp4,
 * review/sheet.jpg, review/report.json.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.env.MANTAGLI_BENCH_ROOT ?? (process.platform === "win32" ? "D:/MantagliArena" : path.resolve(import.meta.dirname, "../../tests/.tmp/arena"));
process.env.MANTAGLI_HOME = path.join(ROOT, "home");
const [W, H] = (process.env.MANTAGLI_ARENA_SIZE ?? "540x960").split("x").map(Number) as [number, number];
const FONT = process.env.MANTAGLI_BENCH_FONT ?? (process.platform === "win32" ? "Bahnschrift" : "Arial");
const { Engine, executeTool } = await import("../../packages/engine/src/index.ts");

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const engine = new Engine();
await engine.init();
// A script drives the edit: no background draft renders of 3D scenes competing for the render lane.
await engine.config.update({ autoRenderScenes: false });
const tool = async (name: string, input: Record<string, unknown>) => {
  const r = await executeTool({ engine, source: "user" }, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.data as any;
};

// Keep rendered 3D frames across rebuilds: the cache is content-addressed (unchanged scenes are reused,
// changed ones get new keys), so only the project itself is rebuilt from scratch.
const sceneCache = path.join(ROOT, "scene-cache");
await rm(sceneCache, { recursive: true, force: true });
await rename(path.join(ROOT, "Arena.mantagli", "cache", "scenes"), sceneCache).catch(() => undefined);
await rm(path.join(ROOT, "Arena.mantagli"), { recursive: true, force: true });
await mkdir(ROOT, { recursive: true });
await engine.createProject({ name: "Arena", format: "vertical", parentDir: ROOT }); // project_create has no folder argument
await mkdir(path.join(ROOT, "Arena.mantagli", "cache"), { recursive: true });
await rename(sceneCache, path.join(ROOT, "Arena.mantagli", "cache", "scenes")).catch(() => undefined);
await tool("project_update_settings", { width: W, height: H });
const s = engine.requireSession();
const k = H / 1920; // type sizes are written for 1080×1920
const track = (name: string) => s.project.tracks.find((t) => t.name === name)!.id;

// ---- 1. Music: the structure drives the edit.
const music = await tool("music_generate", { style: "synthwave", mood: "dark", duration: 22, seed: 7 });
const sec = Object.fromEntries((music.sections as { label: string; frame: number }[]).map((x) => [x.label, x.frame]));
const BUILD = sec.build!;
const DROP = sec.drop!;
const OUTRO = sec.outro!;
const END = 660;
const BAR = Math.round((240 / music.bpm) * 30);
log("music", music.bpm, "BPM, sections", JSON.stringify(music.sections));

// ---- 2. 3D scenes (fast EEVEE: this benchmark must also run on a CPU-only machine).
const quality = { preset: "eeveeFast" };
const horizon = await tool("scene_create", { name: "Horizon", template: "synthwaveHorizon", durationFrames: BUILD });
const chrome = await tool("scene_create", { name: "Arena title", template: "chromeTitle", durationFrames: 2 * BAR, text: "ARENA 7", accentA: "#ff2bd6", accentB: "#1de9b6" });
const metal = await tool("scene_create", { name: "End card", template: "metalTitle", durationFrames: END - OUTRO, text: "JOIN US" });
for (const sc of [horizon, chrome, metal]) await tool("scene_set_render_settings", { sceneId: sc.sceneId, ...quality });

// ---- 3. Picture track, cut to the sections.
const v1 = track("V1");
const shot = (input: Record<string, unknown>) => tool("timeline_add_clip", { trackId: v1, mode: "error", ...input });
await shot({ type: "scene", sceneId: horizon.sceneId, start: 0, duration: BUILD, name: "Horizon" });
// Title cards: lit, textured backdrops (core card backdrops) in the 3D shots' palette, not flat fills.
const build = await shot({ type: "color", fill: "#0a0418", backdrop: { style: "grid", accent: "#1de9b6", light: 0.7, texture: 0.35, focus: 0.74, seed: 7 }, start: BUILD, duration: DROP - BUILD, name: "Build" });
const arena = await shot({ type: "scene", sceneId: chrome.sceneId, start: DROP, duration: 2 * BAR, name: "Arena" });
const cardA = await shot({ type: "color", fill: "#120a1e", backdrop: { style: "studio", accent: "#b04dff", light: 0.75, texture: 0.3, focus: 0.42, seed: 3 }, start: DROP + 2 * BAR, duration: BAR, name: "Card workshops" });
const cardB = await shot({ type: "color", fill: "#02100d", backdrop: { style: "panel", accent: "#1de9b6", light: 0.6, texture: 0.5, focus: 0.5, seed: 5 }, start: DROP + 3 * BAR, duration: OUTRO - (DROP + 3 * BAR), name: "Card battles" });
const end = await shot({ type: "scene", sceneId: metal.sceneId, start: OUTRO, duration: END - OUTRO, name: "End card" });
await tool("timeline_add_transition", { clipId: build.clipId, type: "glitchCut", duration: 8 });
await tool("timeline_add_transition", { clipId: arena.clipId, type: "zoomThrough", duration: 12 });
await tool("transition_apply_preset", { clipIds: [cardA.clipId], preset: "dropWhip" });
await tool("timeline_add_transition", { clipId: cardB.clipId, type: "whipUp", duration: 8 });
await tool("timeline_add_transition", { clipId: end.clipId, type: "flash", duration: 6 });
await tool("timeline_set_clip_properties", { clipId: end.clipId, props: { fadeOut: 24 } });
// Backdrops carry their own light, vignette and static grain; a little moving grain keeps them alive.
for (const c of [build, cardA, cardB]) await tool("effect_add", { clipId: c.clipId, type: "grain", params: { amount: 6 } });

// ---- 4. Typography.
const titles = track("Titles");
const text = (t: string, start: number, duration: number, y: number, size: number, color: string, anim: Record<string, unknown>, extra: Record<string, unknown> = {}, trackId = titles) =>
  tool("timeline_add_clip", {
    trackId,
    mode: "error",
    type: "text",
    text: t,
    start,
    duration,
    transform: { y: y * k },
    style: { fontFamily: FONT, bold: true, fontSize: Math.round(size * k), color, shadow: true, ...extra },
    animation: anim,
  });
await text("PRESS START", 30, BUILD - 40, 560, 84, "#1de9b6", { in: "typewriter", out: "fade", duration: 14 });
const season = await text("SEASON 7", BUILD + 6, DROP - BUILD - 6, -260, 150, "#ffffff", { in: "scramble", out: "none", duration: 16 }, { strokeWidth: 3, strokeColor: "#2a0f5a" });
await tool("effect_add", { clipId: season.clipId, type: "glitch", params: { amount: 0.5, density: 0.15, seed: 4 } });
// Hierarchy as in the references: small accent kicker, big headline with a glow, quiet subline.
const kickers = (await tool("timeline_add_track", { kind: "text", name: "Kickers" })).trackId;
const sublines = (await tool("timeline_add_track", { kind: "text", name: "Sublines" })).trackId;
const card = async (start: number, dur: number, kicker: string, head: string, sub: string, accent: string, y: number, headAnim: Record<string, unknown>, headSize = 128) => {
  await text(kicker, start + 2, dur - 2, y - 150, 44, accent, { in: "fade", out: "none", duration: 6 }, {}, kickers);
  const h = await text(head, start + 4, dur - 4, y, headSize, "#f4f4f6", headAnim, { strokeWidth: 2, strokeColor: accent });
  await tool("effect_add", { clipId: h.clipId, type: "glow", params: { strength: 0.45, radius: 14 } });
  await text(sub, start + 10, dur - 10, y + 140, 42, "#b8b8c8", { in: "fade", out: "none", duration: 8 }, {}, sublines);
};
await card(DROP + 2 * BAR, BAR, "LEARN FROM THE BEST", "WORKSHOPS", "hands-on · beginner to pro", "#e2b6ff", -40, { in: "scramble", out: "none", duration: 8 });
await card(DROP + 3 * BAR, OUTRO - (DROP + 3 * BAR), "> ./compete --live", "CTF BATTLES", "48 hours · teams of four", "#1de9b6", 20, { in: "words", out: "none", duration: 10 }, 104);
await text("14·15 NOV  ·  TUNIS", OUTRO + 40, END - OUTRO - 40, 520, 54, "#ffc356", { in: "typewriter", out: "fade", duration: 18 });

// ---- 5. Voice-over with captions (music ducks under it).
const vo = await tool("voice_narrate", {
  segments: [{ text: "This year, the arena opens again.", start: BUILD + 4 }, { text: "Season seven. Join us.", start: OUTRO + 10 }],
  rate: 0.95,
  captions: true,
  captionStyle: "boxed", // legible over any picture (the grid floor, the end card's smoke)
  duck: true,
});
log("voice", vo.provider, JSON.stringify(vo.segments.map((x: { start: number; frames: number }) => [x.start, x.frames])));

// ---- 6. Finish: CRT look over everything; beat pulse on the drop.
const adj = await tool("timeline_add_track", { kind: "video", name: "Adjust", index: 0 });
const crt = await tool("timeline_add_clip", { trackId: adj.trackId, type: "adjustment", start: 0, duration: END, name: "CRT finish" });
await tool("look_apply", { clipIds: [crt.clipId], look: "crtMonitor" });
const pulse = await tool("timeline_add_track", { kind: "video", name: "Pulse", index: 1 });
const pc = await tool("timeline_add_clip", { trackId: pulse.trackId, type: "adjustment", start: DROP + 2 * BAR, duration: OUTRO - (DROP + 2 * BAR), name: "Beat pulse" });
await tool("effect_add", { clipId: pc.clipId, type: "beatPulse", params: { zoom: 0.03, decay: 7, on: "beats" } });

// ---- 7. Sound design from the picture, then the mix check.
const sd = await tool("sfx_suggest", { intensity: "normal" });
log("sound design", JSON.stringify(sd.suggestions.map((x: { kind: string; anchorFrame: number; reason: string }) => `${x.kind}@${x.anchorFrame} ${x.reason}`)));
await tool("sfx_suggest", { apply: true });
await tool("export_set_settings", { loudnessLufs: -14 });
const meter = await tool("audio_meter", {});
log("mix", JSON.stringify(meter));
const issues = await tool("project_validate", {});
log("validation", JSON.stringify(issues).slice(0, 400));

// MANTAGLI_ARENA_STILLS=1: exact stills of the 2D cards only (no 3D render), for a quick design review.
if (process.env.MANTAGLI_ARENA_STILLS) {
  const dir = path.join(ROOT, "review", "stills");
  await mkdir(dir, { recursive: true });
  const { copyFile } = await import("node:fs/promises");
  for (const [n, f] of [["build", BUILD + 60], ["workshops", DROP + 2 * BAR + 40], ["battles", DROP + 3 * BAR + 45]] as const)
    await copyFile((await engine.renderStill(f, { scale: 1 })).path, path.join(dir, `${n}.png`));
  log("stills", dir);
  await engine.closeProject();
  process.exit(0);
}

// ---- 8. Export through the real pipeline (Blender final frames + FFmpeg) and verify.
const ex = await tool("export_render", { preset: "project" });
let st = ex;
while (!["done", "failed", "cancelled"].includes(st.status)) {
  st = await tool("export_status", { jobId: ex.jobId, waitSeconds: 40 });
  log(st.status, st.progress?.toFixed?.(2) ?? "", st.message ?? "");
}
if (st.status !== "done") throw new Error(`export ${st.status}: ${JSON.stringify(st)}`);
log("export", JSON.stringify(st).slice(0, 600));

// ---- 9. Review material: a frame sheet from the exported file, and the report.
const review = path.join(ROOT, "review");
await mkdir(review, { recursive: true });
const out: string = st.result.outPath;
const times = [1, 3, 4.6, 6.5, 8.3, 9.5, 12, 13.5, 15.5, 17, 19, 21.5];
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", out, "-vf", `select='${times.map((t) => `eq(n\\,${Math.round(t * 30)})`).join("+")}',scale=270:-2,tile=6x2`, "-frames:v", "1", path.join(review, "sheet.jpg")]);
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", out, "-filter_complex", "showwavespic=s=1200x200:split_channels=0", "-frames:v", "1", path.join(review, "wave.png")]);
await writeFile(path.join(review, "report.json"), JSON.stringify({ size: [W, H], music, voice: vo, soundDesign: sd.suggestions, meter, export: st, minutes: (Date.now() - t0) / 60000 }, null, 1));
log("done", out, `${((Date.now() - t0) / 60000).toFixed(1)} min`);
await engine.closeProject();
process.exit(0);
