import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { BackdropSchema, renderBackdrop } from "@mantagli/core";
import { TMP } from "./fixtures.js";

process.env.MANTAGLI_HOME = path.join(TMP, "home-backdrop");
const { Engine } = await import("../src/engine.js");
const engine = new Engine();
afterAll(async () => {
  await engine.closeProject();
});

async function rgb(file: string): Promise<{ w: number; h: number; data: Buffer }> {
  const probe = await promisify(execFile)("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
  const [w, h] = probe.stdout.trim().split(",").map(Number) as [number, number];
  const { stdout } = await promisify(execFile)("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 64 << 20 });
  return { w, h, data: stdout as Buffer };
}

describe("card backdrops in the export", () => {
  it("render the same pixels as the core rasterizer the live preview uses", async () => {
    const dir = path.join(TMP, "backdrop");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await engine.init();
    await engine.createProject({ name: "Backdrop", format: "vertical", parentDir: dir });
    const s = engine.requireSession();
    const v1 = s.project.tracks.find((t) => t.name === "V1")!.id;
    const backdrop = BackdropSchema.parse({ style: "studio", accent: "#c0c8ff", light: 0.7, texture: 0.3, seed: 5 });
    s.dispatch("clip.add", { trackId: v1, clip: { type: "color", fill: "#1a1a22", start: 0, duration: 30, backdrop } }, "user");
    const still = await rgb((await engine.renderStill(10, { scale: 0.25 })).path);
    const ref = renderBackdrop("#1a1a22", backdrop, still.w, still.h);
    let diff = 0;
    for (let i = 0, j = 0; i < still.data.length; i += 3, j += 4) diff += Math.abs(still.data[i]! - ref[j]!) + Math.abs(still.data[i + 1]! - ref[j + 1]!) + Math.abs(still.data[i + 2]! - ref[j + 2]!);
    expect(diff / (still.w * still.h * 3)).toBeLessThan(1.5); // 8-bit rounding through the RGBA overlay path
    // And it is not a flat fill: the lit wall is far brighter than the floor's far corner.
    const at = (x: number, y: number) => still.data[(y * still.w + x) * 3]!;
    expect(at(Math.round(still.w / 2), Math.round(still.h * 0.4))).toBeGreaterThan(at(2, still.h - 3) + 40);
  }, 120_000);
});
