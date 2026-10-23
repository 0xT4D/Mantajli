import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { TMP } from "./fixtures.js";

process.env.MANTAGLI_HOME = path.join(TMP, "home-textfx");
const { Engine } = await import("../src/engine.js");

const engine = new Engine();
afterAll(async () => {
  await engine.closeProject();
});

/** Decode a PNG to raw RGB with FFmpeg. */
async function pixels(file: string): Promise<{ w: number; h: number; at: (x: number, y: number) => [number, number, number] }> {
  const probe = await promisify(execFile)("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
  const [w, h] = probe.stdout.trim().split(",").map(Number) as [number, number];
  const { stdout } = await promisify(execFile)("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 64 << 20 });
  const buf = stdout as Buffer;
  return { w, h, at: (x, y) => [buf[(y * w + x) * 3]!, buf[(y * w + x) * 3 + 1]!, buf[(y * w + x) * 3 + 2]!] };
}

const isRed = ([r, g, b]: [number, number, number]) => r > 180 && g < 60 && b < 60;
const isBlue = ([r, g, b]: [number, number, number]) => b > 180 && r < 60 && g < 60;

/** Horizontal extent of bright pixels (text) in the middle band. */
async function textWidth(file: string): Promise<number> {
  const px = await pixels(file);
  let min = px.w;
  let max = -1;
  for (let y = Math.floor(px.h * 0.3); y < px.h * 0.7; y++)
    for (let x = 0; x < px.w; x++) {
      const [r, g, b] = px.at(x, y);
      if (r + g + b > 400) {
        min = Math.min(min, x);
        max = Math.max(max, x);
      }
    }
  return max < 0 ? 0 : max - min + 1;
}

describe("wipe/iris transitions and typewriter text", () => {
  it("renders masks and typing in the exact (FFmpeg) frame", async () => {
    await engine.init();
    const dir = path.join(TMP, "textfx");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await engine.createProject({ name: "TextFX", format: "landscape", parentDir: dir });
    const s = engine.requireSession();
    const v1 = s.project.tracks.find((t) => t.name === "V1")!.id;
    s.dispatch("clip.add", { trackId: v1, clip: { type: "color", fill: "#ff0000", start: 0, duration: 30 } });
    const blue = s.dispatch("clip.add", { trackId: v1, clip: { type: "color", fill: "#0000ff", start: 30, duration: 30 } });

    // Wipe right, halfway (eased progress 0.5 at u = 0.5): left half blue, right half red.
    s.dispatch("clip.setTransition", { clipId: blue.clipId, transition: { type: "wipeRight", duration: 10 } });
    let px = await pixels((await engine.renderStill(35, { scale: 0.25 })).path);
    expect(isBlue(px.at(Math.floor(px.w * 0.2), px.h / 2))).toBe(true);
    expect(isRed(px.at(Math.floor(px.w * 0.8), px.h / 2))).toBe(true);
    // After the transition the incoming clip is fully visible.
    px = await pixels((await engine.renderStill(41, { scale: 0.25 })).path);
    expect(isBlue(px.at(px.w - 2, px.h / 2))).toBe(true);

    // Iris: centre revealed, corners still the outgoing shot.
    s.dispatch("clip.setTransition", { clipId: blue.clipId, transition: { type: "iris", duration: 10 } });
    px = await pixels((await engine.renderStill(34, { scale: 0.25 })).path);
    expect(isBlue(px.at(px.w / 2, px.h / 2))).toBe(true);
    expect(isRed(px.at(2, 2))).toBe(true);

    // Typewriter: one character on the first frame (10 chars over 10 frames), growing to the full line.
    const titles = s.project.tracks.find((t) => t.name === "Titles")!.id;
    s.dispatch("clip.add", {
      trackId: titles,
      clip: { type: "text", text: "TYPEWRITER", start: 0, duration: 30, style: { color: "#ffffff", fontSize: 140 }, animation: { in: "typewriter", out: "none", duration: 10 } },
    });
    const w0 = await textWidth((await engine.renderStill(0, { scale: 0.5 })).path);
    const w4 = await textWidth((await engine.renderStill(4, { scale: 0.5 })).path);
    const wFull = await textWidth((await engine.renderStill(20, { scale: 0.5 })).path);
    expect(w0).toBeGreaterThan(0);
    expect(w0).toBeLessThan(wFull * 0.2);
    expect(w4).toBeGreaterThan(w0 * 2);
    expect(w4).toBeLessThan(wFull * 0.7);
    // Typing out is the mirror image: the last frame shows nothing.
    const clip = s.project.tracks.find((x) => x.id === titles)!.clips[0]!;
    s.dispatch("clip.update", { clipId: clip.id, props: { animation: { in: "none", out: "typewriter" } } });
    expect(await textWidth((await engine.renderStill(29, { scale: 0.5 })).path)).toBe(0);
    expect(await textWidth((await engine.renderStill(10, { scale: 0.5 })).path)).toBe(wFull);
  });

  it("renders shake and beat pulse exactly where the core curves put them", async () => {
    const { evalLayer, layerCurves } = await import("@mantagli/core");
    const dir = path.join(TMP, "motionfx");
    await engine.closeProject();
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await engine.createProject({ name: "MotionFX", format: "landscape", parentDir: dir });
    const s = engine.requireSession();
    const v1 = s.project.tracks.find((t) => t.name === "V1")!.id;
    const c = s.dispatch("clip.add", { trackId: v1, clip: { type: "color", fill: "#ffffff", start: 0, duration: 40 } });
    s.dispatch("clip.update", { clipId: c.clipId, props: { transform: { scale: 0.5 } } });
    s.dispatch("marker.add", { frame: 10, kind: "beat" });

    /** Bounding box of white pixels. */
    const box = async (frame: number) => {
      const px = await pixels((await engine.renderStill(frame, { scale: 0.25 })).path);
      let [x0, x1, y0, y1] = [px.w, -1, px.h, -1];
      for (let y = 0; y < px.h; y++)
        for (let x = 0; x < px.w; x++) {
          const [r, g, b] = px.at(x, y);
          if (r + g + b > 600) [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
        }
      return { w: x1 - x0 + 1, cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2, W: px.w, H: px.h };
    };

    const fx = s.dispatch("effect.add", { clipId: c.clipId, type: "beatPulse", params: { zoom: 0.2, decay: 6 } });
    const before = await box(9);
    const onBeat = await box(10);
    expect(onBeat.w / before.w).toBeCloseTo(1.2, 1);
    expect((await box(20)).w).toBe(before.w);
    // Moving the marker must invalidate the cached frame.
    s.dispatch("marker.update", { markerId: s.project.markers[0]!.id, frame: 12 });
    expect((await box(10)).w).toBe(before.w);
    s.dispatch("effect.remove", { clipId: c.clipId, effectId: fx.effectId });

    s.dispatch("effect.add", { clipId: c.clipId, type: "shake", params: { amount: 3, rotation: 0, seed: 4 } });
    const clip = s.project.tracks.find((t) => t.id === v1)!.clips[0]!;
    for (const f of [5, 17, 26]) {
      const b = await box(f);
      const st = evalLayer(layerCurves(clip, { width: b.W, height: b.H, hasOutgoing: false, fps: 30, markers: s.project.markers }), f);
      expect(Math.abs(b.cx - (b.W / 2 + st.x))).toBeLessThan(1.5);
      expect(Math.abs(b.cy - (b.H / 2 + st.y))).toBeLessThan(1.5);
    }
  });
});
