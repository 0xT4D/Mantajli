/**
 * "Your ideas. In motion." — a 30 s vertical promo for Mantagli, made with Mantagli: built only
 * through the tool layer the AI Director and MCP clients use, rendered by the app's Blender + FFmpeg
 * pipeline. 1080×1920, 30 fps, 900 frames.
 *
 *   npx tsx scripts/promo-30s/build.ts            # build the project (editable, reopen in the app)
 *   npx tsx scripts/promo-30s/build.ts stills     # + exact review stills of key frames
 *   npx tsx scripts/promo-30s/build.ts export     # + final export, verification, review sheet
 *
 * The stage screen shows a real screenshot of the app with this project open
 * (scripts/promo-30s/ui-screen.mjs writes media/app-ui.png); without it the screen is a plain glow.
 * Output: tests/.tmp/promo-30s/ (or MANTAGLI_PROMO_ROOT).
 */
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { VO_LINES } from "./script.ts";

const ROOT = process.env.MANTAGLI_PROMO_ROOT ?? path.resolve(import.meta.dirname, "../../tests/.tmp/promo-30s");
const NAME = "Mantagli Promo 30s";
const PROJECT = path.join(ROOT, `${NAME}.mantagli`);
const MEDIA = path.join(ROOT, "media");
process.env.MANTAGLI_HOME = path.join(ROOT, "home");
const stage = process.argv[2] ?? "build";
const { Engine, executeTool } = await import("../../packages/engine/src/index.ts");

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const engine = new Engine();
await engine.init();
// A script drives the edit: no background draft renders competing for the render lane.
await engine.config.update({ autoRenderScenes: false, aiMediaFolders: [MEDIA, "/usr/share/fonts/opentype/inter"] });
const tool = async (name: string, input: Record<string, unknown>) => {
  const r = await executeTool({ engine, source: "user" }, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.data as any;
};

// ---- 0. Fresh project; rendered 3D frames survive rebuilds (content-addressed cache).
await mkdir(MEDIA, { recursive: true });
const sceneCache = path.join(ROOT, "scene-cache");
await rm(sceneCache, { recursive: true, force: true });
await rename(path.join(PROJECT, "cache", "scenes"), sceneCache).catch(() => undefined);
await rm(PROJECT, { recursive: true, force: true });
await engine.createProject({ name: NAME, format: "vertical", parentDir: ROOT });
await mkdir(path.join(PROJECT, "cache"), { recursive: true });
await rename(sceneCache, path.join(PROJECT, "cache", "scenes")).catch(() => undefined);
const s = engine.requireSession();
const { width: W, height: H } = s.project.settings;
const track = (name: string) => s.project.tracks.find((t) => t.name === name)!.id;
const F = (sec: number) => Math.round(sec * 30);
const END = 900;

// Brand: the app icon's violet, with cyan; Inter Display (SIL OFL) for type.
const VIOLET = "#7d6bff";
const CYAN = "#38e1ff";
const fonts = await tool("media_import", { paths: ["/usr/share/fonts/opentype/inter/InterDisplay-Black.otf", "/usr/share/fonts/opentype/inter/InterDisplay-SemiBold.otf"] });
const fontId = (n: string) => (fonts.imported as { id: string; name: string }[]).find((a) => a.name.includes(n))!.id;
const BLACK = fontId("Black");
const SEMI = fontId("SemiBold");
const icon = path.join(MEDIA, "mantagli-icon.png");
await copyFile(path.resolve(import.meta.dirname, "../../apps/desktop/app-icon.png"), icon);

// ---- 1. Music first: its structure is the edit. 120 BPM → a bar is 60 frames, a beat 15.
const music = await tool("music_generate", {
  style: "synthwave",
  mood: "uplifting",
  duration: 30,
  bpm: 120,
  seed: 11,
  sections: [
    { kind: "intro", bars: 2 }, //    0–4 s  hook
    { kind: "build", bars: 2 }, //    4–8 s  create
    { kind: "drop", bars: 3 }, //     8–14 s direct
    { kind: "breakdown", bars: 2 }, // 14–18 s sound
    { kind: "build", bars: 1 }, //   18–20 s riser
    { kind: "drop", bars: 3 }, //    20–26 s payoff
    { kind: "outro", bars: 2 }, //   26–30 s brand
  ],
});
log("music", music.bpm, "BPM", JSON.stringify(music.sections.map((x: { label: string; frame: number }) => [x.label, x.frame])));

// ---- 2. 3D scenes (EEVEE; this machine has no GPU). +12 frame handles feed two-sided transitions.
const HANDLE = 12;
const scene = async (name: string, template: string, frames: number, extra: Record<string, unknown> = {}) => {
  const sc = await tool("scene_create", { name, template, durationFrames: frames + HANDLE, ...extra });
  await tool("scene_set_render_settings", { sceneId: sc.sceneId, preset: "eeveeFast" });
  return sc.sceneId as string;
};
const textObject = (sceneId: string) => s.project.scenes.find((x) => x.id === sceneId)!.objects.find((o) => o.kind === "text")!;
const hook = await scene("Hook title", "chromeTitle", 120, { text: "YOUR IDEAS\nIN MOTION", accentA: VIOLET, accentB: CYAN });
await tool("scene_update_object", { sceneId: hook, objectId: textObject(hook).id, patch: { text: { fontAssetId: BLACK } } });
const world = await scene("Neon world", "neonFlythrough", 120, { accentA: VIOLET, accentB: CYAN });
const horizon = await scene("Horizon", "synthwaveHorizon", 60, { accentA: CYAN, accentB: VIOLET });
const motes = await scene("Sound field", "particleBackdrop", 180, { accentA: VIOLET });
const screenAsset = existsSync(path.join(MEDIA, "app-ui.png")) ? (await tool("media_import", { paths: [path.join(MEDIA, "app-ui.png")] })) : undefined;
const screenId = screenAsset ? (screenAsset.imported[0].id as string) : undefined;
const stageSc = await scene("Made in Mantagli", "stageReveal", 90, { accentA: VIOLET, ...(screenId ? { mediaAssetId: screenId } : {}) });
const brand = await scene("Brand", "metalTitle", 120, { text: "MANTAGLI", accentA: VIOLET });
await tool("scene_update_object", { sceneId: brand, objectId: textObject(brand).id, patch: { text: { fontAssetId: BLACK } } });
await tool("scene_set_render_settings", { sceneId: brand, world: { color: "#07040f" } });
log("scenes", s.project.scenes.length, screenId ? "(app UI on the stage screen)" : "(no app UI screenshot yet)");

// ---- 3. Picture (V1), cut to the music.
const v1 = track("V1");
const clip = async (input: Record<string, unknown>) => (await tool("timeline_add_clip", { trackId: v1, mode: "error", ...input })).clipId as string;
const transition = (clipId: string, type: string, duration: number) => tool("timeline_add_transition", { clipId, type, duration });
// Hook: the title rises out of black.
const cHook = await clip({ type: "scene", sceneId: hook, start: 0, duration: 120, name: "Hook" });
await tool("timeline_set_clip_properties", { clipId: cHook, props: { fadeIn: 24 } });
// Create: punch through the title into a world.
const cWorld = await clip({ type: "scene", sceneId: world, start: 120, duration: 120, name: "World" });
await transition(cWorld, "zoomThrough", 12);
// Direct: three treatments, one per bar of the first drop.
const cLight = await clip({ type: "scene", sceneId: horizon, start: 240, duration: 60, name: "Light" });
await tool("transition_apply_preset", { clipIds: [cLight], preset: "dropWhip" });
const cColor = await clip({ type: "scene", sceneId: world, start: 300, duration: 60, sourceIn: 2.0, name: "Color" });
await transition(cColor, "whipUp", 8);
await tool("look_apply", { clipIds: [cColor], look: "vintageFilm" });
const cType = await clip({ type: "color", fill: "#07040f", backdrop: { style: "smoke", accent: VIOLET, light: 0.75, texture: 0.45, focus: 0.47, seed: 4 }, start: 360, duration: 60, name: "Type" });
await transition(cType, "glitchCut", 8);
// Sound: the breakdown breathes; the build rises.
const cSound = await clip({ type: "scene", sceneId: motes, start: 420, duration: 180, name: "Sound" });
await transition(cSound, "dipBlack", 10);
// Payoff: pull back from the app on a stage screen, then a recap cut on every beat.
const cStage = await clip({ type: "scene", sceneId: stageSc, start: 600, duration: 90, name: "Stage" });
await transition(cStage, "zoomThrough", 12);
const recap: [string, Record<string, unknown>][] = [
  ["World", { type: "scene", sceneId: world, sourceIn: 1.0 }],
  ["Horizon", { type: "scene", sceneId: horizon, sourceIn: 0.6 }],
  ["Hook", { type: "scene", sceneId: hook, sourceIn: 3.0 }],
  ["Sound", { type: "scene", sceneId: motes, sourceIn: 4.0 }],
  ["Type card", { type: "color", fill: "#07040f", backdrop: { style: "smoke", accent: CYAN, light: 0.8, texture: 0.45, focus: 0.47, seed: 9 } }],
  ["Stage", { type: "scene", sceneId: stageSc, sourceIn: 2.4 }],
];
const recapIds: string[] = [];
for (const [k, [name, c]] of recap.entries()) recapIds.push(await clip({ ...c, start: 690 + k * 15, duration: 15, name: `Recap ${name}` }));
await transition(recapIds[2]!, "glitchCut", 6);
const typeAgain = await tool("timeline_add_clip", { trackId: track("Titles"), mode: "error", type: "text", text: "TYPE.", start: 750, duration: 15, transform: { y: -40 }, style: { fontAssetId: BLACK, fontSize: 300, color: "#ffffff", shadow: true }, animation: { in: "none", out: "none", duration: 1 } });
await tool("effect_add", { clipId: typeAgain.clipId, type: "glow", params: { strength: 0.55, radius: 16 } });
await transition(recapIds[4]!, "flash", 4);
// Brand: flash into the metal title on the outro hit; fade to black at the end.
const cBrand = await clip({ type: "scene", sceneId: brand, start: 780, duration: 120, name: "Brand" });
await transition(cBrand, "flash", 8);
await tool("timeline_set_clip_properties", { clipId: cBrand, props: { fadeOut: 20 } });

// ---- 4. Typography: kicker / headline / subline, Inter Display, inside the 9:16 safe area.
// Kickers share one line 300 px from the top: clear of headlines and the horizon's sun.
const titles = track("Titles");
const kickers = (await tool("timeline_add_track", { kind: "text", name: "Kickers" })).trackId;
const sublines = (await tool("timeline_add_track", { kind: "text", name: "Sublines" })).trackId;
const words = (await tool("timeline_add_track", { kind: "text", name: "Beat words" })).trackId;
const text = async (trackId: string, t: string, start: number, duration: number, y: number, size: number, color: string, anim: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  (await tool("timeline_add_clip", {
    trackId,
    mode: "error",
    type: "text",
    text: t,
    start,
    duration,
    transform: { y },
    style: { fontAssetId: extra.font ?? BLACK, bold: false, fontSize: size, color, shadow: true, ...(extra.style as object) },
    animation: anim,
  })).clipId as string;
const glow = (clipId: string, strength = 0.4) => tool("effect_add", { clipId, type: "glow", params: { strength, radius: 16 } });
// Create
await text(kickers, "CREATE", 140, 96, -660, 46, CYAN, { in: "fade", out: "fade", duration: 8 }, { font: SEMI });
await glow(await text(titles, "BUILD YOUR\nVISUAL WORLD", 146, 90, -330, 118, "#f4f3ff", { in: "words", out: "fade", duration: 12 }));
// Direct: one word per treatment under a kicker that spans the drop.
await text(kickers, "SHAPE EVERY SHOT", 246, 170, -660, 46, CYAN, { in: "fade", out: "fade", duration: 8 }, { font: SEMI });
await glow(await text(titles, "LIGHT.", 246, 52, 0, 220, "#ffffff", { in: "pop", out: "none", duration: 8 }));
await glow(await text(titles, "COLOR.", 306, 52, 0, 220, "#ffffff", { in: "pop", out: "none", duration: 8 }));
await glow(await text(titles, "TYPE.", 366, 54, -40, 300, "#ffffff", { in: "scramble", out: "none", duration: 10 }, { style: { strokeWidth: 3, strokeColor: VIOLET } }), 0.55);
await text(sublines, "titles · backdrops · looks · transitions", 372, 46, 170, 42, "#c9c4ff", { in: "fade", out: "none", duration: 8 }, { font: SEMI });
// Sound: words land on the beats of the breakdown, then the build lifts the payoff line.
await text(kickers, "SOUND", 425, 112, -660, 46, CYAN, { in: "fade", out: "fade", duration: 8 }, { font: SEMI });
await text(titles, "SCORE.", 435, 102, -260, 170, "#ffffff", { in: "pop", out: "fade", duration: 6 });
await text(sublines, "VOICE.", 465, 72, -60, 170, "#ffffff", { in: "pop", out: "fade", duration: 6 });
await text(words, "SOUND DESIGN.", 495, 42, 140, 120, "#ffffff", { in: "pop", out: "fade", duration: 6 });
await glow(await text(titles, "ON THE\nBEAT.", 545, 49, -60, 210, "#ffffff", { in: "scramble", out: "none", duration: 10 }, { style: { strokeWidth: 3, strokeColor: CYAN } }), 0.5);
// Payoff: a true statement about this very video.
await text(kickers, "THIS PROMO WAS MADE IN MANTAGLI", 616, 70, -660, 44, CYAN, { in: "typewriter", out: "fade", duration: 20 }, { font: SEMI });
// Brand
await text(sublines, "AI-directed 3D montage studio", 822, 78, 190, 52, "#d9d4ff", { in: "fade", out: "fade", duration: 14 }, { font: SEMI });
const logo = await tool("media_import", { paths: [icon] });
const logoId = logo.imported[0].id as string;
const v2 = track("V2");
const cLogo = (await tool("timeline_add_clip", { trackId: v2, type: "media", assetId: logoId, start: 806, duration: 94, transform: { y: -470, scale: 0.16, fit: "fit" } })).clipId as string;
await tool("timeline_set_clip_properties", { clipId: cLogo, props: { blendMode: "lighten", fadeIn: 12, fadeOut: 20 } });
await tool("effect_add", { clipId: cLogo, type: "basicColor", params: { contrast: 1.7, saturation: 0.55 } });
await tool("effect_add", { clipId: cLogo, type: "glow", params: { strength: 0.6, radius: 14 } });

// ---- 5. Voice-over (best local engine; never a cloud default) with captions; music ducks under it.
const vo = await tool("voice_narrate", {
  segments: VO_LINES.map((l) => ({ text: l.text, start: l.start })),
  provider: "rhvoice",
  voice: "bdl",
  captions: true,
  captionStyle: "boxed",
  captionPosition: "bottom",
  duck: true,
});
log("voice", vo.provider, JSON.stringify(vo.segments.map((x: { start: number; frames: number }) => [x.start, x.frames])));

// ---- 6. Finish: one restrained grade over everything, beat pulse on the payoff recap.
const adj = await tool("timeline_add_track", { kind: "video", name: "Finish", index: 0 });
const fin = await tool("timeline_add_clip", { trackId: adj.trackId, type: "adjustment", start: 0, duration: END, name: "Finish" });
await tool("effect_add", { clipId: fin.clipId, type: "vignette", params: { amount: 0.35 } });
await tool("effect_add", { clipId: fin.clipId, type: "grain", params: { amount: 5 } });
const pulse = await tool("timeline_add_track", { kind: "video", name: "Pulse", index: 1 });
const pc = await tool("timeline_add_clip", { trackId: pulse.trackId, type: "adjustment", start: 690, duration: 90, name: "Beat pulse" });
await tool("effect_add", { clipId: pc.clipId, type: "beatPulse", params: { zoom: 0.035, decay: 8, on: "beats" } });

// ---- 7. Sound design from the picture, a hit as the hook title appears, then the mix.
await tool("sfx_generate", { kind: "impact", anchorFrame: 10, gainDb: -10 });
const sd = await tool("sfx_suggest", { intensity: "normal" });
log("sound design", JSON.stringify(sd.suggestions.map((x: { kind: string; anchorFrame: number }) => `${x.kind}@${x.anchorFrame}`)));
await tool("sfx_suggest", { apply: true });
await tool("export_set_settings", { loudnessLufs: -14 });
const meter = await tool("audio_meter", {});
log("mix", JSON.stringify(meter));
const issues = await tool("project_validate", {});
log("validation", JSON.stringify(issues).slice(0, 400));
await tool("project_save", {});
log("project", PROJECT);

const review = path.join(ROOT, "review");
await mkdir(review, { recursive: true });
if (stage === "stills") {
  // Exact frames at export quality (renders and caches the 3D frames they need).
  for (const f of (process.argv[3] ?? "60,200,270,330,390,470,560,650,735,860").split(",").map(Number)) {
    const t = Date.now();
    await copyFile((await engine.renderStill(f, { scale: 1, quality: "final" })).path, path.join(review, `still_${String(f).padStart(3, "0")}.png`));
    log("still", f, `${((Date.now() - t) / 1000).toFixed(0)} s`);
  }
}
if (stage === "export") {
  const ex = await tool("export_render", { preset: "project" });
  let st = ex;
  while (!["done", "failed", "cancelled"].includes(st.status)) {
    st = await tool("export_status", { jobId: ex.jobId, waitSeconds: 40 });
    log(st.status, st.progress?.toFixed?.(2) ?? "", st.message ?? "");
  }
  if (st.status !== "done") throw new Error(`export ${st.status}: ${JSON.stringify(st)}`);
  const out: string = st.result.outPath;
  const final = path.join(ROOT, "mantagli-promo-30s.mp4");
  await copyFile(out, final);
  const times = [0.5, 2.5, 5.5, 8.5, 10.5, 12.5, 15.5, 18.5, 21.5, 24, 27, 29.3];
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", out, "-vf", `select='${times.map((t) => `eq(n\\,${Math.round(t * 30)})`).join("+")}',scale=270:-2,tile=6x2`, "-frames:v", "1", path.join(review, "contact-sheet.jpg")]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", out, "-filter_complex", "showwavespic=s=1600x240:split_channels=0", "-frames:v", "1", path.join(review, "waveform.png")]);
  await writeFile(path.join(review, "report.json"), JSON.stringify({ size: [W, H], music, voice: vo, soundDesign: sd.suggestions, meter, export: st, minutes: (Date.now() - t0) / 60000 }, null, 1));
  log("done", final, `${((Date.now() - t0) / 60000).toFixed(1)} min`);
}
await engine.closeProject();
process.exit(0);
