/**
 * Build a cinematic 3D promotional reel for Mantagli
 */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = "D:/MantagliShowcase";
const MEDIA = path.join(ROOT, "media");
process.env.MANTAGLI_HOME = path.join(ROOT, "home");

const { Engine, executeTool } = await import("../packages/engine/src/index.ts");
const engine = new Engine();
await engine.init();
const tool = async (name: string, input: any) => {
  const r = await executeTool({ engine, source: "user" }, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.data;
};

await engine.createProject({ name: "Mantagli Promo Reel", format: "vertical", parentDir: ROOT });
const s = engine.requireSession();

const TOTAL = 900;

const scorePath = path.join(MEDIA, "promo_score.wav");
try { execSync(`node scripts/promo/score.mjs ${scorePath}`, { stdio: "inherit" }); } catch(e) { console.log(e); }

await copyFile("C:/Windows/Fonts/segoeuib.ttf", path.join(MEDIA, "SegoeUI-Bold.ttf"));
await copyFile("C:/Windows/Fonts/arial.ttf", path.join(MEDIA, "Arial.ttf"));

await tool("media_import", { paths: [scorePath, path.join(MEDIA, "SegoeUI-Bold.ttf"), path.join(MEDIA, "Arial.ttf")] });
const asset = (name: string) => s.project.assets.find((a: any) => a.name === name)!.id;

console.log("Creating 3D scenes...");
const quality = { render: { engine: "eevee", samples: 64, motionBlur: true, shutter: 0.5, bloom: true } };

const neon = await tool("scene_create", { name: "Neon Intro", template: "neonFlythrough", durationFrames: 150, accentA: "#ff00ff", accentB: "#00ffff" });
await tool("scene_set_render_settings", { sceneId: neon.sceneId, ...quality });
const logo = await tool("scene_create", { name: "Chrome Logo", template: "chromeTitle", durationFrames: 120, text: "MANTAGLI", accentA: "#8b5cf6", accentB: "#06b6d4", particles: true });
await tool("scene_set_render_settings", { sceneId: logo.sceneId, ...quality });
const portal = await tool("scene_create", { name: "Arcade Portal", template: "arcadePortal", durationFrames: 150, accentA: "#00ff88", accentB: "#ff00ff" });
await tool("scene_set_render_settings", { sceneId: portal.sceneId, ...quality });
const horizon = await tool("scene_create", { name: "Synthwave", template: "synthwaveHorizon", durationFrames: 150, accentA: "#ff0080", accentB: "#00ffff" });
await tool("scene_set_render_settings", { sceneId: horizon.sceneId, ...quality });
const metal = await tool("scene_create", { name: "Metal Title", template: "metalTitle", durationFrames: 180, text: "3D MONTAGE STUDIO" });
await tool("scene_set_render_settings", { sceneId: metal.sceneId, ...quality });
const treasure = await tool("scene_create", { name: "Treasure", template: "treasureHoard", durationFrames: 120, accentA: "#ffd700", accentB: "#ff6b00" });
await tool("scene_set_render_settings", { sceneId: treasure.sceneId, ...quality });

console.log("Building timeline...");
for (const t of [...s.project.tracks]) s.dispatch("track.remove", { trackId: t.id });
const V1 = (await tool("timeline_add_track", { kind: "video", name: "Main" })).trackId;
const TITLES = (await tool("timeline_add_track", { kind: "text", name: "Titles" })).trackId;
const CAPS = (await tool("timeline_add_track", { kind: "text", name: "Captions" })).trackId;
const MUSIC = (await tool("timeline_add_track", { kind: "audio", name: "Music", role: "music" })).trackId;

await tool("timeline_add_clip", { trackId: MUSIC, type: "media", assetId: asset("promo_score.wav"), start: 0, duration: TOTAL });
await tool("audio_analyze", { assetId: asset("promo_score.wav"), applyMarkers: true });

const bold = asset("SegoeUI-Bold.ttf");
const arial = asset("Arial.ttf");

const textClip = async (track: string, text: string, start: number, duration: number, style: any, animation: any, y = 0) =>
  (await tool("timeline_add_clip", { trackId: track, type: "text", text, start, duration, style, animation, transform: { y } })).clipId;

let currentFrame = 0;
let c1 = (await tool("timeline_add_clip", { trackId: V1, type: "scene", sceneId: neon.sceneId, start: currentFrame, duration: 150 })).clipId;
await tool("timeline_set_clip_properties", { clipId: c1, props: { fadeIn: 15 } });
await tool("effect_add", { clipId: c1, type: "letterbox", params: { ratio: "2.39" } });
await tool("effect_add", { clipId: c1, type: "glow", params: { strength: 0.5, radius: 25 } });
await textClip(TITLES, "MANTAGLI", 30, 90, { fontAssetId: bold, fontSize: 90, color: "#ffffff", strokeWidth: 3, strokeColor: "#ff00ff", shadow: true }, { in: "scramble", out: "fade", duration: 20 }, -200);
currentFrame += 130;

let c2 = (await tool("timeline_add_clip", { trackId: V1, type: "scene", sceneId: logo.sceneId, start: currentFrame, duration: 120 })).clipId;
await tool("timeline_add_transition", { clipId: c2, type: "whipLeft", duration: 12 });
await tool("effect_add", { clipId: c2, type: "letterbox", params: { ratio: "2.39" } });
await tool("effect_add", { clipId: c2, type: "glow", params: { strength: 0.4, radius: 20 } });
await textClip(CAPS, "AI-DIRECTED 3D MONTAGE STUDIO", currentFrame + 40, 60, { fontAssetId: arial, fontSize: 36, color: "#00ffff", shadow: true }, { in: "words", out: "fade", duration: 12 }, 380);
currentFrame += 108;

let c3 = (await tool("timeline_add_clip", { trackId: V1, type: "scene", sceneId: portal.sceneId, start: currentFrame, duration: 150 })).clipId;
await tool("timeline_add_transition", { clipId: c3, type: "zoomThrough", duration: 10 });
await tool("effect_add", { clipId: c3, type: "letterbox", params: { ratio: "2.39" } });
await textClip(TITLES, "SEAMLESS PORTALS", currentFrame + 50, 70, { fontAssetId: bold, fontSize: 65, color: "#00ff88", strokeWidth: 2, strokeColor: "#000000", shadow: true }, { in: "typewriter", out: "fade", duration: 15 }, -250);
currentFrame += 140;

let c4 = (await tool("timeline_add_clip", { trackId: V1, type: "scene", sceneId: horizon.sceneId, start: currentFrame, duration: 150 })).clipId;
await tool("timeline_add_transition", { clipId: c4, type: "glitchCut", duration: 10 });
await tool("effect_add", { clipId: c4, type: "letterbox", params: { ratio: "2.39" } });
await tool("effect_add", { clipId: c4, type: "scanlines", params: { spacing: 4, amount: 0.15 } });
await textClip(CAPS, "CINEMATIC TRANSITIONS", currentFrame + 60, 60, { fontAssetId: arial, fontSize: 38, color: "#ff0080", shadow: true }, { in: "slideUp", out: "fade", duration: 10 }, 380);
currentFrame += 140;

let c5 = (await tool("timeline_add_clip", { trackId: V1, type: "scene", sceneId: metal.sceneId, start: currentFrame, duration: 180 })).clipId;
await tool("timeline_add_transition", { clipId: c5, type: "whipRight", duration: 14 });
await tool("effect_add", { clipId: c5, type: "letterbox", params: { ratio: "2.39" } });
await tool("effect_add", { clipId: c5, type: "glow", params: { strength: 0.6, radius: 30 } });
await textClip(TITLES, "BEAT SYNCED EDITS", currentFrame + 40, 80, { fontAssetId: bold, fontSize: 70, color: "#ffd700", strokeWidth: 3, strokeColor: "#8b0000", shadow: true }, { in: "scramble", out: "fade", duration: 18 }, -220);
currentFrame += 166;

let c6 = (await tool("timeline_add_clip", { trackId: V1, type: "scene", sceneId: treasure.sceneId, start: currentFrame, duration: 120 })).clipId;
await tool("timeline_add_transition", { clipId: c6, type: "zoomIn", duration: 12 });
await tool("timeline_set_clip_properties", { clipId: c6, props: { fadeOut: 40 } });
await tool("effect_add", { clipId: c6, type: "letterbox", params: { ratio: "2.39" } });
await tool("effect_add", { clipId: c6, type: "glow", params: { strength: 0.5, radius: 25 } });
await textClip(TITLES, "CREATE YOUR MONTAGE", currentFrame + 20, 60, { fontAssetId: bold, fontSize: 68, color: "#ffffff", strokeWidth: 3, strokeColor: "#b8860b", shadow: true }, { in: "scramble", out: "fade", duration: 16 }, -200);
await textClip(CAPS, "BLENDER • FFMPEG • AI POWERED", currentFrame + 90, 40, { fontAssetId: arial, fontSize: 32, color: "#ffd700", shadow: true }, { in: "fade", out: "fade", duration: 12 }, 320);

const adj = (await tool("timeline_add_track", { kind: "video", name: "Finish" })).trackId;
const crt = (await tool("timeline_add_clip", { trackId: adj, type: "adjustment", start: 0, duration: currentFrame + 120, name: "Cinematic Finish" })).clipId;
await tool("effect_add", { clipId: crt, type: "vignette", params: { amount: 0.4 } });
await tool("effect_add", { clipId: crt, type: "grain", params: { amount: 4 } });

try { await tool("sfx_generate", { kind: "whoosh", anchorFrame: 130, gainDb: -6 }); } catch(e){}
try { await tool("sfx_generate", { kind: "whoosh", anchorFrame: 238, gainDb: -6, pitch: 0.8 }); } catch(e){}
try { await tool("sfx_generate", { kind: "impact", anchorFrame: 508, gainDb: -4 }); } catch(e){}
try { await tool("sfx_generate", { kind: "glitch", anchorFrame: 378, gainDb: -10 }); } catch(e){}

await tool("export_set_settings", { codec: "h264", crf: 14, encoderPreset: "slow", audioBitrateK: 320, loudnessLufs: -14 });
await s.save({ backup: true });

console.log("Exporting...");
await mkdir(path.join(ROOT, "out"), { recursive: true });
const outPath = path.join(ROOT, "out", "Mantagli_Cinematic_Promo_Reel.mp4");
const t0 = Date.now();
const exp = engine.startExport({ preset: "vertical1080", outPath });
const r = await exp.promise;
console.log("COMPLETE!");
console.log(JSON.stringify(r.check));
console.log(`Time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(outPath);

await engine.closeProject();
process.exit(0);
