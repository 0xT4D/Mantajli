/**
 * Builds the 20 s Mantagli promo inside Mantagli, through the same tools the AI
 * Director and MCP clients use. Run scripts/promo/look.ts first (3D scenes).
 *
 *   npx tsx scripts/promo/build.ts timeline   # assets + timeline (UI shots as placeholders)
 *   node scripts/promo/ui-shots.mjs           # 4K screenshots of the app showing this project
 *   npx tsx scripts/promo/build.ts ui         # place the UI shots
 *   npx tsx scripts/promo/build.ts stills     # review stills
 *   npx tsx scripts/promo/build.ts export     # final verified export
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = "D:/MantagliPromo";
const MEDIA = path.join(ROOT, "media");
process.env.MANTAGLI_HOME = path.join(ROOT, "home");
const { Engine, executeTool } = await import("../../packages/engine/src/index.ts");
const stage = process.argv[2] ?? "timeline";

const engine = new Engine();
await engine.init();
const tool = async (name: string, input: Record<string, unknown>) => {
  const r = await executeTool({ engine, source: "user" }, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.data as any;
};

// Beat grid of the score: 120 BPM at 30 fps → a beat every 15 frames, drop at 240, end hit at 480.
const F = (sec: number) => Math.round(sec * 30);
const DROP = 240;
const END = 480;
const TOTAL = 600;
const SHOT = 30;

/** UI shots in the drop: screenshot file, focus point (UI pixels) and zoom. */
export const UI_SHOTS = [
  { slot: 0, file: "ui_editor.png", cx: 960, cy: 540, z0: 1.0, z1: 1.1 },
  { slot: 2, file: "ui_3d.png", cx: 1250, cy: 390, z0: 1.5, z1: 1.6 },
  { slot: 4, file: "ui_autoedit.png", cx: 960, cy: 590, z0: 1.8, z1: 1.95 },
  { slot: 5, file: "ui_director.png", cx: 1748, cy: 962, z0: 2.1, z1: 2.25, card: true },
  { slot: 7, file: "ui_export.png", cx: 955, cy: 540, z0: 1.8, z1: 1.95 },
];
const CAPTIONS = ["CUT TO THE BEAT", "SPEED RAMPS", "REAL 3D · BLENDER", "", "AUTO-EDIT TO MUSIC", "DIRECTED BY CLAUDE", "MASKS · BLENDS · KEYING", "EXPORT. VERIFIED."];
const TRANSITIONS: (null | { type: string; duration: number })[] = [
  { type: "flash", duration: 8 },
  { type: "zoomIn", duration: 6 },
  { type: "wipeLeft", duration: 6 },
  { type: "slideUp", duration: 6 },
  { type: "iris", duration: 8 },
  { type: "slideLeft", duration: 6 },
  { type: "wipeRight", duration: 6 },
  { type: "zoomIn", duration: 6 },
];

async function openPromo() {
  await engine.openProject(path.join(ROOT, "Mantagli Promo.mantagli"), { force: true });
  return engine.requireSession();
}

if (stage === "timeline") {
  // ---- neon flythrough rendered to footage by Mantagli itself (so it can be speed-ramped)
  const neonMp4 = path.join(MEDIA, "neon_flythrough.mp4");
  if (!(await import("node:fs")).existsSync(neonMp4)) {
    const dir = path.join(ROOT, "Promo Assets.mantagli");
    await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
    await engine.createProject({ name: "Promo Assets", format: "landscape", parentDir: ROOT });
    const neon = await tool("scene_create", { name: "Neon", template: "neonFlythrough", durationFrames: 150, accentA: "#ff2bd6", accentB: "#22d3ee" });
    await tool("scene_set_render_settings", { sceneId: neon.sceneId, preset: "eeveeHigh" });
    const v1 = engine.project.tracks.find((t) => t.name === "V1")!.id;
    await tool("timeline_add_clip", { trackId: v1, type: "scene", sceneId: neon.sceneId, start: 0, duration: 150 });
    await tool("export_set_settings", { crf: 12, encoderPreset: "slow" });
    const { promise } = engine.startExport({ preset: "landscape1080", outPath: neonMp4 });
    const r = await promise;
    console.log("neon footage", r.check.width, r.check.height, r.check.duration);
    await engine.closeProject();
  }
  // ---- the promo project (scenes were created by look.ts)
  const s = await openPromo();
  const sceneId = (name: string) => s.project.scenes.find((x) => x.name === name)!.id;
  // Fonts and media.
  await copyFile("C:/Windows/Fonts/segoeuib.ttf", path.join(MEDIA, "SegoeUI-Bold.ttf"));
  await copyFile("C:/Windows/Fonts/bahnschrift.ttf", path.join(MEDIA, "Bahnschrift.ttf"));
  const want = [path.join(MEDIA, "mantagli_score.wav"), neonMp4, path.join(MEDIA, "SegoeUI-Bold.ttf"), path.join(MEDIA, "Bahnschrift.ttf")];
  const toImport = want.filter((p) => !s.project.assets.some((a) => a.name === path.basename(p)));
  if (toImport.length) await tool("media_import", { paths: toImport });
  const asset = (name: string) => s.project.assets.find((a) => a.name === name)!.id;
  const bold = asset("SegoeUI-Bold.ttf");
  const light = asset("Bahnschrift.ttf");

  // Fresh timeline every run (UI screenshots are re-imported by the "ui" stage).
  for (const a of s.project.assets.filter((x) => x.name.startsWith("ui_"))) s.dispatch("asset.remove", { assetId: a.id, force: true });
  for (const t of [...s.project.tracks]) s.dispatch("track.remove", { trackId: t.id });
  for (const m of [...s.project.markers]) s.dispatch("marker.remove", { markerId: m.id });
  const add = async (kind: string, name: string, role?: string) => (await tool("timeline_add_track", { kind, name, ...(role ? { role } : {}) })).trackId as string;
  // Created bottom-up: each new visual track goes on top.
  const V1 = await add("video", "Picture");
  const V2 = await add("video", "Overlay");
  const TITLES = await add("text", "Titles");
  const CAPS = await add("text", "Captions");
  const MUSIC = await add("audio", "Score", "music");

  // ---- music + beat detection (markers drive cuts and beat pulse)
  await tool("timeline_add_clip", { trackId: MUSIC, type: "media", assetId: asset("mantagli_score.wav"), start: 0, duration: TOTAL });
  const beats = await tool("audio_analyze", { assetId: asset("mantagli_score.wav"), applyMarkers: true });
  console.log(`score: ${beats.bpm.toFixed(1)} BPM, ${beats.beatFrames.length} beats`);
  await tool("timeline_add_marker", { frame: DROP, label: "DROP", kind: "section" });
  await tool("timeline_add_marker", { frame: END, label: "END CARD", kind: "section" });

  const textClip = async (track: string, text: string, start: number, duration: number, style: Record<string, unknown>, animation: Record<string, unknown>, y = 0) =>
    (await tool("timeline_add_clip", { trackId: track, type: "text", text, start, duration, style, animation, transform: { y } })).clipId as string;

  // ---- intro (0–4 s): particles, letterbox, typewriter line
  const particles = (await tool("timeline_add_clip", { trackId: V1, type: "scene", sceneId: sceneId("Particles"), start: 0, duration: 120 })).clipId;
  await tool("timeline_set_clip_properties", { clipId: particles, props: { fadeIn: 24 } });
  await tool("effect_add", { clipId: particles, type: "letterbox", params: { ratio: "2.39" } });
  await tool("effect_add", { clipId: particles, type: "glow", params: { strength: 0.45, radius: 24 } });
  const introStyle = { fontAssetId: light, fontSize: 64, color: "#e8e6ff", shadow: true, bold: false };
  await textClip(TITLES, "Every great edit", 14, 50, introStyle, { in: "typewriter", out: "fade", duration: 18 }, -20);
  await textClip(TITLES, "starts with a beat.", 66, 50, { ...introStyle, color: "#ffffff" }, { in: "words", out: "fade", duration: 16 }, -20);

  // ---- build (4–8 s): chrome logo reveal
  const logo = (await tool("timeline_add_clip", { trackId: V1, type: "scene", sceneId: sceneId("Logo"), start: 120, duration: 120 })).clipId;
  await tool("timeline_add_transition", { clipId: logo, type: "crossfade", duration: 16 });
  // A gentler camera push than the template default, so the wordmark stays inside the frame.
  for (const name of ["Logo", "EndLogo"]) {
    const logoScene = s.project.scenes.find((x) => x.name === name)!;
    const camId = logoScene.objects.find((o) => o.kind === "camera")!.id;
    await tool("scene_animate", { sceneId: logoScene.id, objectId: camId, property: "location", keyframes: [{ frame: 0, value: [-1.2, -14, 1.2], easing: "easeInOut" }, { frame: 119, value: [0.5, -10.8, 0.4], easing: "linear" }] });
    await tool("scene_animate", { sceneId: logoScene.id, objectId: camId, property: "focusDistance", keyframes: [{ frame: 0, value: [14], easing: "easeInOut" }, { frame: 119, value: [10.8], easing: "linear" }] });
  }
  await tool("effect_add", { clipId: logo, type: "letterbox", params: { ratio: "2.39" } });
  await tool("effect_add", { clipId: logo, type: "glow", params: { strength: 0.35, radius: 18 } });
  await tool("effect_add", { clipId: logo, type: "shake", params: { amount: 0.25, frequency: 3, rotation: 0.2, seed: 7 } });
  await textClip(TITLES, "AI-DIRECTED  3D  MONTAGE  STUDIO", 168, 66, { fontAssetId: light, fontSize: 34, color: "#c9c4ff", shadow: false, bold: false }, { in: "slideUp", out: "fade", duration: 12 }, 250);

  // ---- drop (8–16 s): eight 1-beat-pair shots
  const neon = asset("neon_flythrough.mp4");
  for (let i = 0; i < 8; i++) {
    const start = DROP + i * SHOT;
    let clipId: string;
    if (i === 1) {
      clipId = (await tool("timeline_add_clip", { trackId: V1, type: "media", assetId: neon, start, duration: SHOT })).clipId;
      await tool("timeline_set_speed_ramp", { clipId, ramp: "flashMotion" });
      await tool("effect_add", { clipId, type: "glitch", params: { amount: 0.35, density: 0.25, seed: 4 } });
    } else if (i === 3) {
      clipId = (await tool("timeline_add_clip", { trackId: V1, type: "scene", sceneId: sceneId("Gem"), start, duration: SHOT })).clipId;
      await tool("effect_add", { clipId, type: "glow", params: { strength: 0.4, radius: 20 } });
    } else if (i === 6) {
      // Split screen with shape masks: neon footage left, reversed; the logo render right.
      clipId = (await tool("timeline_add_clip", { trackId: V1, type: "media", assetId: neon, start, duration: SHOT, sourceIn: 2 })).clipId;
      await tool("timeline_set_clip_properties", { clipId, props: { reverse: true } });
      await tool("effect_add", { clipId, type: "mask", params: { shape: "rectangle", x: -0.25, width: 0.5, height: 1.2, feather: 0.004 } });
      const right = (await tool("timeline_add_clip", { trackId: V2, type: "scene", sceneId: sceneId("EndLogo"), start, duration: SHOT, sourceIn: 3 })).clipId;
      await tool("effect_add", { clipId: right, type: "mask", params: { shape: "rectangle", x: 0.25, width: 0.5, height: 1.2, feather: 0.004 } });
      await tool("timeline_set_clip_properties", { clipId: right, props: { transform: { scale: 1.6 } } });
      // A thin light seam between the halves, screen-blended.
      const seam = (await tool("timeline_add_track", { kind: "video", name: "Seam" })).trackId;
      const line = (await tool("timeline_add_clip", { trackId: seam, type: "color", start, duration: SHOT, fill: "#b9a8ff" })).clipId;
      await tool("effect_add", { clipId: line, type: "mask", params: { shape: "rectangle", x: 0, width: 0.003, height: 1.2, feather: 0.006 } });
      await tool("timeline_set_clip_properties", { clipId: line, props: { blendMode: "screen" } });
    } else {
      // UI shot placeholder, replaced in the "ui" stage.
      clipId = (await tool("timeline_add_clip", { trackId: V1, type: "color", start, duration: SHOT, fill: "#101018" })).clipId;
      await tool("timeline_set_clip_properties", { clipId, props: { name: `UI slot ${i}` } });
    }
    const t = TRANSITIONS[i];
    if (t) await tool("timeline_add_transition", { clipId, type: t.type, duration: t.duration });
    await tool("effect_add", { clipId, type: "beatPulse", params: { zoom: 0.035, decay: 7, on: "beats" } });
    await tool("effect_add", { clipId, type: "vignette", params: { amount: 0.35 } });
    if (CAPTIONS[i]) await textClip(CAPS, CAPTIONS[i]!, start + 2, SHOT - 3, { fontAssetId: bold, fontSize: 70, color: "#ffffff", strokeWidth: 0, shadow: true, bold: true }, { in: "pop", out: "none", duration: 4 }, 370);
  }
  // Camera shake punctuates the drop.
  const first = engine.project.tracks.find((t) => t.id === V1)!.clips.find((c) => c.start === DROP)!;
  await tool("effect_add", { clipId: first.id, type: "shake", params: { amount: 0.6, frequency: 12, rotation: 0.6, seed: 2 } });

  // ---- end card (16–20 s): gold logo, tagline, fade to black
  const endLogo = (await tool("timeline_add_clip", { trackId: V1, type: "scene", sceneId: sceneId("EndLogo"), start: END, duration: TOTAL - END })).clipId;
  await tool("timeline_add_transition", { clipId: endLogo, type: "flash", duration: 10 });
  await tool("timeline_set_clip_properties", { clipId: endLogo, props: { fadeOut: 24 } });
  await tool("effect_add", { clipId: endLogo, type: "letterbox", params: { ratio: "2.39" } });
  await tool("effect_add", { clipId: endLogo, type: "glow", params: { strength: 0.4, radius: 22 } });
  await tool("effect_add", { clipId: endLogo, type: "grain", params: { amount: 6 } });
  await textClip(TITLES, "The AI-directed 3D montage studio", END + 30, 88, { fontAssetId: light, fontSize: 46, color: "#f4ecff", shadow: true, bold: false }, { in: "words", out: "fade", duration: 22 }, 235);
  await textClip(CAPS, "Blender   ·   FFmpeg   ·   Claude", END + 52, 66, { fontAssetId: light, fontSize: 28, color: "#a9a3c9", shadow: false, bold: false }, { in: "fade", out: "fade", duration: 14 }, 300);

  // ---- mix and delivery
  await tool("export_set_settings", { codec: "h264", crf: 14, encoderPreset: "slow", audioBitrateK: 320, loudnessLufs: -14 });
  await tool("plan_save", {
    brief: "20 s cinematic promo for Mantagli, cut to an original 120 BPM score",
    summary: "Intro particles + typewriter line → chrome logo build → 8-shot drop on the beat (UI, speed-ramped 3D footage, gold gem, split screen) → gold end card",
    status: "executing",
    shots: [
      { index: 0, description: "Particles + 'Every great edit starts with a beat.'", startFrame: 0, durationFrames: 120 },
      { index: 1, description: "Chrome MANTAGLI logo reveal, riser", startFrame: 120, durationFrames: 120 },
      { index: 2, description: "Drop: 8 beat-cut feature shots with kinetic captions", startFrame: 240, durationFrames: 240 },
      { index: 3, description: "Gold end card + tagline", startFrame: 480, durationFrames: 120 },
    ],
  });
  await engine.requireSession().save({ backup: true });
  const v = await tool("project_validate_render", { preset: "landscape1080" });
  console.log("validate:", v.ok, JSON.stringify(v.issues));
}

if (stage === "ui") {
  const s = await openPromo();
  const V1 = s.project.tracks.find((t) => t.name === "Picture")!;
  const shots = UI_SHOTS.map((u) => path.join(MEDIA, u.file));
  const newShots = shots.filter((p) => !s.project.assets.some((a) => a.name === path.basename(p)));
  if (newShots.length) await tool("media_import", { paths: newShots });
  for (const u of UI_SHOTS) {
    const start = DROP + u.slot * SHOT;
    const slot = s.project.tracks.find((t) => t.id === V1.id)!.clips.find((c) => c.start === start)!;
    const keep = { transitionIn: slot.transitionIn, effects: slot.effects };
    await tool("timeline_remove_clip", { clipIds: [slot.id] });
    const card = (u as { card?: boolean }).card;
    if (card) {
      // Background for the floating card: the particles render.
      const bg = (await tool("timeline_add_clip", { trackId: V1.id, type: "scene", sceneId: s.project.scenes.find((x) => x.name === "Particles")!.id, start, duration: SHOT, sourceIn: 1 })).clipId;
      if (keep.transitionIn) await tool("timeline_add_transition", { clipId: bg, type: keep.transitionIn.type, duration: keep.transitionIn.duration });
      await tool("effect_add", { clipId: bg, type: "glow", params: { strength: 0.4, radius: 20 } });
    }
    const track = card ? s.project.tracks.find((t) => t.name === "Overlay")!.id : V1.id;
    const id = (await tool("timeline_add_clip", { trackId: track, type: "media", assetId: s.project.assets.find((a) => a.name === u.file)!.id, start, duration: SHOT })).clipId;
    await tool("timeline_set_clip_properties", { clipId: id, props: { name: u.file.replace(".png", ""), transform: { fit: "fill" } } });
    if (keep.transitionIn) await tool("timeline_add_transition", { clipId: id, type: keep.transitionIn.type, duration: keep.transitionIn.duration });
    for (const e of keep.effects) await tool("effect_add", { clipId: id, type: e.type, params: e.params });
    // Card: only the AI panel shows, as a rounded-feel floating window above the caption.
    if (card) await tool("effect_add", { clipId: id, type: "mask", params: { shape: "rectangle", x: 0, y: -0.07, width: 0.4, height: 0.42, feather: 0.006 } });
    // Push in on the feature: position follows the zoom so the focus point stays centred,
    // clamped so the zoomed screenshot always covers the frame (no black edges).
    for (const [frame, z] of [[0, u.z0], [SHOT - 1, u.z1]] as const) {
      // Full-frame shots must keep covering the frame; masked cards may move freely.
      const cx = card ? u.cx : Math.max(960 - 960 * (1 - 1 / z), Math.min(960 + 960 * (1 - 1 / z), u.cx));
      const cy = card ? u.cy : Math.max(540 - 540 * (1 - 1 / z), Math.min(540 + 540 * (1 - 1 / z), u.cy));
      Object.assign(u, { cx, cy });
      await tool("timeline_set_keyframe", { clipId: id, property: "scale", frame, value: z, easing: "easeOut" });
      await tool("timeline_set_keyframe", { clipId: id, property: "x", frame, value: (960 - u.cx) * z, easing: "easeOut" });
      await tool("timeline_set_keyframe", { clipId: id, property: "y", frame, value: (540 - u.cy) * z - (card ? 0.07 * 1080 : 0), easing: "easeOut" });
    }
  }
  await engine.requireSession().save({ backup: true });
  console.log("UI shots placed");
}

if (stage === "stills") {
  await openPromo();
  const frames = process.argv.slice(3).map(Number);
  const list = frames.length ? frames : [30, 90, 150, 225, 244, 262, 285, 315, 345, 375, 405, 435, 465, 500, 560];
  const out: string[] = [];
  for (const f of list) out.push((await engine.renderStill(f, { scale: 0.5, quality: "final" })).path);
  await writeFile(path.join(ROOT, "stills.txt"), out.join("\n"));
  console.log(out.length, "stills");
}

if (stage === "export") {
  await openPromo();
  await mkdir(path.join(ROOT, "out"), { recursive: true });
  const outPath = path.join(ROOT, "out", "Mantagli_Promo_1080p.mp4");
  const t0 = Date.now();
  const { promise } = engine.startExport({ preset: "landscape1080", outPath });
  const r = await promise;
  console.log(JSON.stringify(r.check), `${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await tool("plan_save", { brief: "20 s cinematic promo for Mantagli", status: "done", summary: `Exported ${outPath}` });
}

await engine.closeProject();
process.exit(0);
