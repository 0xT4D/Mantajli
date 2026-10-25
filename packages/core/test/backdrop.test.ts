import { describe, expect, it } from "vitest";
import { applyCommand, BACKDROP_STYLES, BackdropSchema, createProject, renderBackdrop, type Project } from "../src/index.js";

const lum = (px: Uint8ClampedArray, W: number, x: number, y: number) => {
  const i = (Math.round(y) * W + Math.round(x)) * 4;
  return 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!;
};
const mean = (px: Uint8ClampedArray) => {
  let s = 0;
  for (let i = 0; i < px.length; i += 4) s += px[i]! + px[i + 1]! + px[i + 2]!;
  return s / (px.length / 4) / 3;
};

describe("card backdrops", () => {
  it("are deterministic, opaque, and lit where the focus is", () => {
    for (const style of BACKDROP_STYLES.filter((s) => s !== "flat")) {
      const b = BackdropSchema.parse({ style, accent: "#ff3060", seed: 3 });
      const a = renderBackdrop("#100818", b, 90, 160);
      expect(Array.from(a), style).toEqual(Array.from(renderBackdrop("#100818", b, 90, 160)));
      for (let i = 3; i < a.length; i += 4) expect(a[i]).toBe(255);
      // Brighter at the focus (centre, 45 % down) than in the corner: light, depth and vignette.
      expect(lum(a, 90, 45, 72), style).toBeGreaterThan(lum(a, 90, 3, 3) + 4);
      // A different seed changes the texture.
      expect(Array.from(renderBackdrop("#100818", { ...b, seed: 4 }, 90, 160)), style).not.toEqual(Array.from(a));
    }
  });

  it("keep their picture at any resolution (shapes are in frame units; only the grain is per pixel)", () => {
    const b = BackdropSchema.parse({ style: "spotlight", texture: 0 });
    const small = renderBackdrop("#000000", b, 54, 96);
    const big = renderBackdrop("#000000", b, 216, 384);
    for (const [fx, fy] of [[0.5, 0.45], [0.2, 0.8], [0.9, 0.1]] as const)
      expect(Math.abs(lum(small, 54, fx * 54 - 0.5, fy * 96 - 0.5) - lum(big, 216, fx * 216 - 0.5, fy * 384 - 0.5))).toBeLessThan(6);
    // No light, no texture: just the fill under the vignette.
    const unlit = renderBackdrop("#808080", BackdropSchema.parse({ style: "spotlight", light: 0, texture: 0 }), 54, 96);
    expect(lum(unlit, 54, 27, 48)).toBeCloseTo(128, -1);
    expect(mean(unlit)).toBeLessThan(128);
  });

  it("are set, patched and cleared through clip commands", () => {
    let p: Project = createProject({ name: "B", format: "vertical" });
    const v1 = p.tracks.find((t) => t.name === "V1")!.id;
    const add = applyCommand(p, "clip.add", { trackId: v1, clip: { type: "color", fill: "#101010", start: 0, duration: 30, backdrop: BackdropSchema.parse({ style: "smoke" }) } });
    p = add.project;
    const id = (add.result as { clipId: string }).clipId;
    const clip = () => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id) as { backdrop?: { style: string; light: number; accent: string } };
    p = applyCommand(p, "clip.update", { clipId: id, props: { backdrop: { light: 0.9 } } }).project;
    expect(clip().backdrop).toMatchObject({ style: "smoke", light: 0.9, accent: "#ff2bd6" }); // patch keeps the rest
    p = applyCommand(p, "clip.update", { clipId: id, props: { backdrop: null } }).project;
    expect(clip().backdrop).toBeUndefined();
  });
});
