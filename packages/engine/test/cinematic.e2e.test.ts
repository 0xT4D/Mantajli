import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TMP } from "./fixtures.js";
import { bbox, pixels, type RGB } from "./pixels.js";

/**
 * Session-4 cinematic features rendered for real (FFmpeg/Blender) and checked
 * against the core formulas: easings, scramble text, adjustment layers, lens
 * effects, two-sided transitions, 3D media planes, camera paths, scatter.
 * Frames worth looking at are copied to tests/.tmp/cinematic/shots.
 */

process.env.MANTAGLI_HOME = path.join(TMP, "home-cinematic");
const { Engine } = await import("../src/engine.js");
const engine = new Engine();
const ROOT = path.join(TMP, "cinematic");
const SHOTS = path.join(ROOT, "shots");

beforeAll(async () => {
  await engine.init();
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(SHOTS, { recursive: true });
});
afterAll(async () => {
  await engine.closeProject();
});

async function fresh(name: string, format: "landscape" | "vertical" | "square" = "landscape") {
  await engine.closeProject();
  const dir = path.join(ROOT, name);
  await mkdir(dir, { recursive: true });
  await engine.createProject({ name, format, parentDir: dir });
  return engine.requireSession();
}

async function still(frame: number, scale = 0.25, keep?: string) {
  const r = await engine.renderStill(frame, { scale });
  if (keep) await copyFile(r.path, path.join(SHOTS, `${keep}.png`));
  return pixels(r.path);
}

/** Decode frames of a video as RGB images (by index). */
async function videoFrames(file: string, indices: number[]) {
  const { run } = await import("../src/util/proc.js");
  const out: Record<number, Awaited<ReturnType<typeof pixels>>> = {};
  for (const i of indices) {
    const png = path.join(SHOTS, `vf_${path.basename(file)}_${i}.png`);
    const r = await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `select=eq(n\\,${i})`, "-frames:v", "1", png]);
    if (r.code !== 0) throw new Error(r.stderr);
    out[i] = await pixels(png);
  }
  return out;
}

async function frameCount(file: string): Promise<number> {
  const { run } = await import("../src/util/proc.js");
  const r = await run("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file]);
  return Number(r.stdout.trim());
}

describe("adjustment layers and lens effects", () => {
  it("applies an adjustment layer to everything below it, only while it is on the timeline", async () => {
    const s = await fresh("adjust");
    const v1 = s.project.tracks.find((t) => t.name === "V1")!.id;
    s.dispatch("clip.add", { trackId: v1, clip: { type: "color", fill: "#ff2020", start: 0, duration: 60 } });
    const titles = s.project.tracks.find((t) => t.name === "Titles")!.id;
    s.dispatch("clip.add", { trackId: titles, clip: { type: "text", text: "ABOVE", start: 0, duration: 60, style: { color: "#00ff00", fontSize: 200, shadow: false }, animation: { in: "none", out: "none" } } });
    // Adjustment between V1 and the titles: greys V1 but not the green title above it.
    const adj = s.dispatch("track.add", { kind: "video", name: "Adjust", index: 1 });
    const a = s.dispatch("clip.add", { trackId: adj.trackId, clip: { type: "adjustment", start: 20, duration: 20 } });
    s.dispatch("effect.add", { clipId: a.clipId, type: "basicColor", params: { saturation: 0 } });

    const r = await engine.renderPreviewRange(0, 60, { scale: 0.25 });
    expect(await frameCount(r.path)).toBe(60);
    const f = await videoFrames(r.path, [10, 19, 20, 30, 39, 40, 50]);
    const corner = (i: number) => f[i]!.at(4, 4);
    const isRed = ([R, G, B]: RGB) => R > 180 && G < 90 && B < 90;
    const isGrey = ([R, G, B]: RGB) => Math.abs(R - G) < 20 && Math.abs(G - B) < 20 && R > 30;
    for (const i of [10, 19, 40, 50]) expect(isRed(corner(i)), `frame ${i} red`).toBe(true);
    for (const i of [20, 30, 39]) expect(isGrey(corner(i)), `frame ${i} grey`).toBe(true);
    // The title above the adjustment keeps its colour.
    const g = bbox(f[30]!, ([R, G, B]) => G > 180 && R < 120 && B < 120);
    expect(g.found).toBe(true);
  });

  it("distorts like the core lens formula and draws scanlines on the export grid", async () => {
    const { lensCoefficients, lensSource } = await import("@mantagli/core");
    const s = await fresh("lens");
    const v1 = s.project.tracks.find((t) => t.name === "V1")!.id;
    const c = s.dispatch("clip.add", { trackId: v1, clip: { type: "color", fill: "#ffffff", start: 0, duration: 10 } });
    s.dispatch("effect.add", { clipId: c.clipId, type: "lensDistortion", params: { amount: 0.5 } });
    const px = await still(0, 0.25, "lens");
    expect(px.at(0, 0)[0]).toBeLessThan(20); // corners fall outside the picture
    expect(px.at(px.w / 2, px.h / 2)[0]).toBeGreaterThan(240);
    // First picture row in the centre column, measured vs predicted.
    const k = lensCoefficients(0.5);
    let measured = -1;
    for (let y = 0; y < px.h / 2 && measured < 0; y++) if (px.at(px.w / 2, y)[0] > 128) measured = y;
    let predicted = -1;
    for (let y = 0; y < px.h / 2 && predicted < 0; y++) if (lensSource(px.w / 2, y + 0.5, px.w, px.h, k)[1] >= 0) predicted = y;
    expect(measured).toBeGreaterThan(0);
    expect(Math.abs(measured - predicted)).toBeLessThanOrEqual(2);

    // Scanlines: every 8 output px (spacing 32 project px at 1/4 scale), 4 px dark at 50%.
    s.dispatch("effect.remove", { clipId: c.clipId, effectId: s.project.tracks.find((t) => t.id === v1)!.clips[0]!.effects[0]!.id });
    s.dispatch("effect.add", { clipId: c.clipId, type: "scanlines", params: { amount: 0.5, spacing: 16 } });
    const sl = await still(0, 0.5, "scanlines");
    const col = Array.from({ length: 16 }, (_, y) => sl.at(100, y)[0]);
    expect(col.slice(0, 4).every((v) => Math.abs(v - 128) < 6)).toBe(true);
    expect(col.slice(4, 8).every((v) => v > 245)).toBe(true);
    expect(col.slice(8, 12).every((v) => Math.abs(v - 128) < 6)).toBe(true);
  });

  it("darkens with the core vignette formula (shared with the live preview)", async () => {
    const { vignetteFactor } = await import("@mantagli/core");
    const s = await fresh("vignette");
    const v1 = s.project.tracks.find((t) => t.name === "V1")!.id;
    const c = s.dispatch("clip.add", { trackId: v1, clip: { type: "color", fill: "#ffffff", start: 0, duration: 10 } });
    s.dispatch("effect.add", { clipId: c.clipId, type: "vignette", params: { amount: 0.8 } });
    const px = await still(0, 0.25, "vignette");
    // Along the diagonal from the centre to a corner (BT.709 round trip: allow ±4 levels).
    for (const t of [0, 0.25, 0.5, 0.75, 0.95]) {
      const x = px.w / 2 + t * (px.w / 2 - 1);
      const y = px.h / 2 + t * (px.h / 2 - 1);
      const want = 255 * vignetteFactor(Math.round(x), Math.round(y), px.w, px.h, 0.8);
      expect(Math.abs(px.at(x, y)[1] - want), `t=${t}: ${px.at(x, y)[1]} vs ${want.toFixed(1)}`).toBeLessThanOrEqual(4);
    }
  });

  it("finishes the whole frame with the CRT look on an adjustment layer", async () => {
    const s = await fresh("crt", "vertical");
    const v1 = s.project.tracks.find((t) => t.name === "V1")!.id;
    s.dispatch("clip.add", { trackId: v1, clip: { type: "color", fill: "#1de9b6", start: 0, duration: 30 } });
    const titles = s.project.tracks.find((t) => t.name === "Titles")!.id;
    s.dispatch("clip.add", { trackId: titles, clip: { type: "text", text: "CYBER\nCAMP", start: 0, duration: 30, style: { color: "#ffffff", fontSize: 220 }, animation: { in: "none", out: "none" } } });
    const adj = s.dispatch("track.add", { kind: "video", name: "Adjust", index: 0 });
    const a = s.dispatch("clip.add", { trackId: adj.trackId, clip: { type: "adjustment", start: 0, duration: 30 } });
    const { lookSpec } = await import("@mantagli/core");
    for (const e of lookSpec("crtMonitor")!.effects) s.dispatch("effect.add", { clipId: a.clipId, type: e.type, params: e.params });
    const px = await still(10, 0.5, "crt_look");
    expect(px.at(1, 1)[1]).toBeLessThan(30); // rounded black corners
    expect(px.at(px.w / 2, px.h * 0.08)[1]).toBeGreaterThan(80); // picture near the top edge centre
  });
});

describe("two-sided transitions", () => {
  async function twoShots(name: string, type: string, d: number) {
    const s = await fresh(name);
    const v1 = s.project.tracks.find((t) => t.name === "V1")!.id;
    s.dispatch("clip.add", { trackId: v1, clip: { type: "color", fill: "#ff0000", start: 0, duration: 30 } });
    const b = s.dispatch("clip.add", { trackId: v1, clip: { type: "color", fill: "#0000ff", start: 30, duration: 30 } });
    s.dispatch("clip.setTransition", { clipId: b.clipId, transition: { type, duration: d } });
    const r = await engine.renderPreviewRange(0, 60, { scale: 0.25 });
    const { videoPixels } = await import("./pixels.js");
    const frames = await videoPixels(r.path);
    return { s, v1, frames };
  }
  const red = ([R, , B]: RGB) => R > 150 && B < 100;
  const blue = ([R, , B]: RGB) => B > 150 && R < 100;
  const notBlack = ([R, G, B]: RGB) => R + G + B > 60;

  it("whip pan: shots stay butted together where the core curve puts them, with a motion-blurred seam", async () => {
    const { buildCompositionPlan, evalLayer, layerCurves } = await import("@mantagli/core");
    const { s, frames } = await twoShots("whip", "whipLeft", 10);
    expect(frames).toHaveLength(60);
    const out = buildCompositionPlan(s.project).layers[0]!;
    const W = frames[0]!.w;
    const H = frames[0]!.h;
    for (const f of [32, 35, 37]) {
      const px = frames[f]!;
      const xo = evalLayer(layerCurves(out.clip, { width: W, height: H, hasOutgoing: false, fps: 30, transitionOut: out.transitionOut }), f).x;
      const y = Math.floor(H / 2);
      let seam = -1;
      for (let x = 1; x < W && seam < 0; x++) if (px.at(x, y)[2] > px.at(x, y)[0]) seam = x;
      expect(Math.abs(seam - (W + xo)), `seam at frame ${f}`).toBeLessThan(4);
      for (let x = 0; x < W; x += 7) expect(notBlack(px.at(x, y)), `no gap at frame ${f}, x ${x}`).toBe(true);
    }
    // Blur: around the peak the seam is a wide ramp, not a hard edge.
    const mid = frames[35]!;
    let mixed = 0;
    for (let x = 0; x < W; x++) {
      const [R, , B] = mid.at(x, H / 2);
      if (R > 40 && B > 40) mixed++;
    }
    expect(mixed).toBeGreaterThan(20);
    expect(red(frames[29]!.at(W / 2, H / 2))).toBe(true);
    expect(blue(frames[41]!.at(W / 2, H / 2))).toBe(true);
    await copyFile((await engine.renderStill(35, { scale: 0.5 })).path, path.join(SHOTS, "whip_f35.png"));
  });

  it("whips the framed pictures, not the overflow of wide sources in a vertical frame", async () => {
    const { run } = await import("../src/util/proc.js");
    const red = path.join(ROOT, "wide_red.png");
    const blue = path.join(ROOT, "wide_blue.png");
    for (const [f, c] of [[red, "red"], [blue, "blue"]] as const) await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=${c}:s=1280x720`, "-frames:v", "1", f]);
    const s = await fresh("whipwide", "vertical");
    await engine.importMedia([red, blue]);
    const [ra, ba] = s.project.assets;
    const v1 = s.project.tracks.find((t) => t.name === "V1")!.id;
    s.dispatch("clip.add", { trackId: v1, clip: { type: "media", assetId: ra!.id, start: 0, duration: 30 } });
    const b = s.dispatch("clip.add", { trackId: v1, clip: { type: "media", assetId: ba!.id, start: 30, duration: 30 } });
    s.dispatch("clip.setTransition", { clipId: b.clipId, transition: { type: "whipLeft", duration: 10 } });
    // Mid-whip: left half still shows the outgoing (red) picture, right half the incoming (blue).
    const px = await still(35, 0.25, "whip_wide_f35");
    const at = (u: number) => px.at(Math.floor(px.w * u), Math.floor(px.h / 2));
    expect(at(0.12)[0], "outgoing visible on the left").toBeGreaterThan(150);
    expect(at(0.12)[2]).toBeLessThan(100);
    expect(at(0.88)[2], "incoming on the right").toBeGreaterThan(150);
  });

  it("holds the last frame of an outgoing clip without handles (no black under the transition)", async () => {
    const { makeFixtures } = await import("./fixtures.js");
    const fx = await makeFixtures();
    const s = await fresh("nohandles");
    await engine.importMedia([fx.video]);
    const v = s.project.assets[0]!;
    const v1 = s.project.tracks.find((t) => t.name === "V1")!.id;
    // clip_a is 6 s: in at 4 s for 2 s ends exactly at the end of the source.
    s.dispatch("clip.add", { trackId: v1, clip: { type: "media", assetId: v.id, start: 0, duration: 60, sourceIn: 4 } });
    const b = s.dispatch("clip.add", { trackId: v1, clip: { type: "color", fill: "#0000ff", start: 60, duration: 30 } });
    s.dispatch("clip.setTransition", { clipId: b.clipId, transition: { type: "whipLeft", duration: 12 } });
    // A still inside the tail starts past the end of the source file.
    const px = await still(66, 0.25, "nohandles_f66");
    const left = px.at(Math.floor(px.w * 0.2), Math.floor(px.h / 2));
    expect(left[0] + left[1] + left[2], "outgoing frame held, not black").toBeGreaterThan(60);
  });

  it("zoom through and glitch cut: cut in the middle, frame always covered", async () => {
    for (const type of ["zoomThrough", "glitchCut"]) {
      const { frames } = await twoShots(type, type, 10);
      expect(frames).toHaveLength(60);
      const { w: W, h: H } = frames[0]!;
      for (let f = 30; f < 35; f++) expect(red(frames[f]!.at(W / 2, H / 2)), `${type} ${f} outgoing`).toBe(true);
      for (let f = 35; f < 45; f++) expect(blue(frames[f]!.at(W / 2, H / 2)), `${type} ${f} incoming`).toBe(true);
      for (let f = 28; f < 42; f++) for (const [x, y] of [[W * 0.1, H * 0.1], [W * 0.9, H * 0.9], [W / 2, H / 2]] as const) expect(notBlack(frames[f]!.at(x, y)), `${type} ${f}`).toBe(true);
    }
  });
});

describe("3D: media planes, camera paths, scatter", () => {
  it("plays a video on a screen in the scene, holds still between snap moves, and fills the frame for portals", async () => {
    const { makeFixtures } = await import("./fixtures.js");
    const { meanDiff } = await import("./pixels.js");
    const fx = await makeFixtures();
    const s = await fresh("portal3d", "vertical");
    await engine.importMedia([fx.video]);
    const vid = s.project.assets[0]!;

    // Stage reveal starts with the screen filling the frame: almost every pixel is the video.
    const st = s.dispatch("scene.create", { name: "Reveal", durationFrames: 30, template: "stageReveal", mediaAssetId: vid.id });
    const reveal = await engine.renderScene(st.sceneId, { quality: "draft", scale: 0.25, frames: [1, 2, 30] });
    const f1 = await pixels(path.join(reveal.dir, "frame_00001.png"));
    const f2 = await pixels(path.join(reveal.dir, "frame_00002.png"));
    const f30 = await pixels(path.join(reveal.dir, "frame_00030.png"));
    let dark = 0;
    for (let y = 0; y < f1.h; y += 4) for (let x = 0; x < f1.w; x += 4) if (f1.at(x, y).reduce((a, b) => a + b, 0) < 30) dark++;
    expect(dark / ((f1.w / 4) * (f1.h / 4))).toBeLessThan(0.05); // the screen covers the frame
    expect(meanDiff(f1, f30)).toBeGreaterThan(20); // and the camera has pulled back by the end
    // testsrc2 animates: the video texture advances between frames.
    expect(meanDiff(f1, f2)).toBeGreaterThan(0.5);
    await copyFile(path.join(reveal.dir, "frame_00030.png"), path.join(SHOTS, "stage_reveal_end.png"));

    // Snap-and-settle: frames inside a hold are identical, frames across a snap differ.
    const tt = s.dispatch("scene.create", { name: "Stations", durationFrames: 60, template: "turntableStage", stops: [20, 40], particles: false });
    const scene = s.project.scenes.find((x) => x.id === tt.sceneId)!;
    const camKeys = scene.objects.find((o) => o.kind === "camera")!.animation.find((a) => a.property === "pathProgress")!.keyframes;
    expect(camKeys.map((k) => [k.frame, k.value[0], k.easing])).toEqual([
      [20, 0, "expoOut"],
      [40, 0.5, "expoOut"],
      [60, 1, "hold"],
    ]);
    const r = await engine.renderScene(tt.sceneId, { quality: "draft", scale: 0.2, frames: [5, 15, 22, 41, 50, 58] });
    const fr = async (n: number) => pixels(path.join(r.dir, `frame_${String(n).padStart(5, "0")}.png`));
    // Scene frame n+1 shows timeline frame n: 5/15 are inside the first hold.
    expect(meanDiff(await fr(5), await fr(15))).toBeLessThan(0.5);
    expect(meanDiff(await fr(15), await fr(22))).toBeGreaterThan(3);
    expect(meanDiff(await fr(50), await fr(58))).toBeGreaterThan(0.5); // second move (40+20 steps) still settling into 60
    await copyFile(path.join(r.dir, "frame_00015.png"), path.join(SHOTS, "turntable_hold.png"));
  });

  it("scatters thousands of instances and validates referenced assets", async () => {
    const s = await fresh("scatter3d");
    const sc = s.dispatch("scene.create", { name: "Hoard", durationFrames: 10, template: "treasureHoard" });
    const coins = s.project.scenes[0]!.objects.find((o) => o.name === "Coins")!;
    expect(coins.scatter!.count).toBe(2600);
    const r = await engine.renderScene(sc.sceneId, { quality: "draft", scale: 0.25, frames: [1] });
    const px = await pixels(path.join(r.dir, "frame_00001.png"));
    // Gold pile in the lower middle: warm, bright pixels (red > blue clearly).
    const warm = bbox(px, ([R, G, B]) => R > 120 && R > B * 1.6 && G > 60);
    expect(warm.found).toBe(true);
    expect(warm.w).toBeGreaterThan(px.w * 0.3);
    // Media planes must reference an image or video.
    expect(() => s.dispatch("scene.addObject", { sceneId: sc.sceneId, object: { kind: "media", name: "Bad", media: { assetId: "nope" } } as never })).toThrow(/image or video/);
    expect(() => s.dispatch("scene.animate", { sceneId: sc.sceneId, objectId: coins.id, property: "pathProgress", keyframes: [{ frame: 0, value: [0] }] })).toThrow(/path/);
  });

  it("bursts scatter pieces: hidden before the start, airborne, then settled on the floor — the same pixels every render", async () => {
    const { meanDiff } = await import("./pixels.js");
    const s = await fresh("burst3d");
    // Empty stage: camera at (0, -10, 1) looking 5° down. Glowing coins launch at scene frame 10
    // from z = 0.5 (≈5 m/s up, peak ≈ 1.75 m) and land on z = 0 after ≈ 1.1 s.
    const sc = s.dispatch("scene.create", { name: "Burst", durationFrames: 75, template: "empty" });
    const gold = { preset: "custom", baseColor: "#ffffff", metallic: 0, roughness: 0.5, emissionColor: "#ffd040", emissionStrength: 25, transmission: 0 };
    const add = s.dispatch("scene.addObject", {
      sceneId: sc.sceneId,
      object: { kind: "scatter", name: "Coins", location: [0, 0, 0.5], scatter: { primitive: "coin", distribution: "box", count: 40, area: [0.15, 0.15, 0.05], size: 0.25, seed: 3 }, material: gold } as never,
    });
    // Burst added by a partial patch: the stored burst gets the schema defaults for the rest.
    s.dispatch("scene.updateObject", { sceneId: sc.sceneId, objectId: add.objectId, patch: { scatter: { burst: { frame: 10, speed: 6, spread: 25, bounce: 0.3, stagger: 0 } } } as never });
    const burst = s.project.scenes[0]!.objects.find((o) => o.id === add.objectId)!.scatter!.burst!;
    expect(burst).toMatchObject({ frame: 10, speed: 6, gravity: 9.81, floor: 0, direction: [0, 0, 1] });

    const frames = [5, 22, 74, 75]; // Blender frames = scene frames + 1
    const r = await engine.renderScene(sc.sceneId, { quality: "draft", scale: 0.25, frames });
    const file = (f: number) => path.join(r.dir, `frame_${String(f).padStart(5, "0")}.png`);
    for (const f of frames) await copyFile(file(f), path.join(SHOTS, `burst_f${f}.png`));
    const core = ([R, G]: RGB) => R > 230 && G > 200; // the coins themselves, not their bloom
    const before = bbox(await pixels(file(5)), core);
    const mid = bbox(await pixels(file(22)), core);
    const end = bbox(await pixels(file(75)), core);
    expect(before.found).toBe(false); // not launched yet: scaled to nothing
    expect(mid.found).toBe(true);
    expect(end.found).toBe(true);
    const H = (await pixels(file(75))).h;
    expect(mid.cy).toBeLessThan(H * 0.35); // high in the air
    expect(end.y0).toBeGreaterThan(H * 0.4); // all down at the floor (its line is just below the centre)
    expect(end.w).toBeGreaterThan(mid.w * 0.6); // spread out by the cone
    // Settled: nothing moves any more between the last two frames.
    expect(meanDiff(await pixels(file(74)), await pixels(file(75)))).toBeLessThan(0.5);

    // Deterministic: the same frame rendered again (no cache) is the same picture.
    const again = path.join(SHOTS, "burst_f22_first.png");
    await copyFile(file(22), again);
    await rm(file(22));
    await engine.renderScene(sc.sceneId, { quality: "draft", scale: 0.25, frames: [22] });
    expect(meanDiff(await pixels(again), await pixels(file(22)))).toBeLessThan(1);
  });
});

describe("music structure", () => {
  it("finds drops and breakdowns and writes labelled section markers", async () => {
    const { run } = await import("../src/util/proc.js");
    const wav = path.join(ROOT, "structure.wav");
    const K = "sin(2*PI*55*t)*exp(-30*mod(t,0.5))";
    const H = "(random(0)-0.5)*exp(-60*mod(t+0.25,0.5))";
    // 120 BPM: quiet intro, drop at 8 s, breakdown at 16 s, drop again at 20 s, end at 28 s.
    const expr = `if(lt(t,8),0.12*${K},if(lt(t,16),0.9*${K}+0.35*${H},if(lt(t,20),0.06*sin(2*PI*220*t),0.9*${K}+0.35*${H})))`;
    const r = await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${expr}':s=44100:d=28`, "-ac", "2", wav]);
    expect(r.code, r.stderr).toBe(0);
    const s = await fresh("structure");
    await engine.importMedia([wav]);
    const a = s.project.assets[0]!;
    const music = s.project.tracks.find((t) => t.role === "music")!.id;
    s.dispatch("clip.add", { trackId: music, clip: { type: "media", assetId: a.id, start: 30 } }); // placed at 1 s
    const res = await engine.analyzeBeats(a.id);
    const secs = res.analysis.sections;
    // Boundaries snap to the nearest detected beat (up to 0.3 s away).
    const near = (t: number, label: string) => secs.find((x) => Math.abs(x.time - t) <= 0.35 && x.label === label);
    expect(near(8, "drop"), JSON.stringify(secs)).toBeDefined();
    expect(near(16, "breakdown"), JSON.stringify(secs)).toBeDefined();
    expect(near(20, "drop"), JSON.stringify(secs)).toBeDefined();
    // Markers sit on the timeline where the music clip is (offset by its 30-frame start).
    const marks = s.project.markers.filter((m) => m.kind === "section");
    expect(marks.map((m) => m.label)).toEqual(expect.arrayContaining(["drop", "breakdown"]));
    const drop = marks.find((m) => m.label === "drop")!;
    expect(Math.abs(drop.frame - (30 + 8 * 30))).toBeLessThanOrEqual(18);
  });
});

describe("easing and text animation", () => {
  it("moves a layer along an expo-out curve exactly as core evaluates it", async () => {
    const { evalLayer, layerCurves } = await import("@mantagli/core");
    const s = await fresh("easing");
    const v1 = s.project.tracks.find((t) => t.name === "V1")!.id;
    const c = s.dispatch("clip.add", { trackId: v1, clip: { type: "color", fill: "#ffffff", start: 0, duration: 40 } });
    s.dispatch("clip.update", { clipId: c.clipId, props: { transform: { scale: 0.3 } } });
    s.dispatch("keyframe.set", { clipId: c.clipId, property: "x", keyframe: { frame: 0, value: -600, easing: "expoOut" } });
    s.dispatch("keyframe.set", { clipId: c.clipId, property: "x", keyframe: { frame: 30, value: 600, easing: "linear" } });
    const clip = s.project.tracks.find((t) => t.id === v1)!.clips[0]!;
    for (const f of [2, 6, 15, 29]) {
      const px = await still(f);
      const b = bbox(px);
      const st = evalLayer(layerCurves(clip, { width: px.w, height: px.h, hasOutgoing: false, fps: 30 }), f);
      // Keyframed x is in project pixels (1920 wide); the still is at 1/4 scale.
      expect(Math.abs(b.cx - (px.w / 2 + st.x * (px.w / 1920)))).toBeLessThan(1.5);
    }
  });

  it("renders scramble text decoding into the final title", async () => {
    const s = await fresh("scramble");
    const titles = s.project.tracks.find((t) => t.name === "Titles")!.id;
    s.dispatch("clip.add", {
      trackId: titles,
      clip: { type: "text", text: "CYBER CAMP", start: 0, duration: 40, style: { color: "#ffffff", fontSize: 150, shadow: false }, animation: { in: "scramble", out: "scramble", duration: 12 } },
    });
    const early = bbox(await still(1, 0.5, "scramble_f01"));
    const mid = await still(6, 0.5, "scramble_f06");
    const done = bbox(await still(20, 0.5, "scramble_f20"));
    expect(early.found).toBe(true);
    expect(early.w).toBeLessThan(done.w * 0.6);
    expect(bbox(mid).found).toBe(true);
    // The decoded frame equals a plain (unanimated) title.
    const clip = s.project.tracks.find((t) => t.id === titles)!.clips[0]!;
    s.dispatch("clip.update", { clipId: clip.id, props: { animation: { in: "none", out: "none" } } });
    const plain = bbox(await still(20, 0.5));
    expect(done.w).toBe(plain.w);
    // Last frame of the out-scramble shows nothing.
    s.dispatch("clip.update", { clipId: clip.id, props: { animation: { in: "scramble", out: "scramble" } } });
    expect(bbox(await still(39, 0.5)).found).toBe(false);
  });
});
