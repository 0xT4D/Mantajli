import { describe, expect, it } from "vitest";
import {
  applyCommand,
  AssetSchema,
  buildCompositionPlan,
  createProject,
  findClip,
  maxClipDuration,
  sourceOffset,
  speedAt,
  SPEED_RAMP_PRESETS,
  validateProject,
  type Clip,
  type Project,
} from "../src/index.js";

function setup(duration = 20): { p: Project; clipId: string } {
  let p = createProject({ name: "Ramp", format: "landscape" });
  const asset = AssetSchema.parse({
    id: "ast_v",
    kind: "video",
    name: "v.mp4",
    path: "C:/media/v.mp4",
    size: 1,
    hash: "h",
    importedAt: new Date().toISOString(),
    meta: { duration, width: 1920, height: 1080, hasVideo: true, hasAudio: true },
  });
  p = applyCommand(p, "asset.add", { asset }).project;
  const v1 = p.tracks.find((t) => t.name === "V1")!.id;
  const r = applyCommand(p, "clip.add", { trackId: v1, clip: { type: "media", assetId: "ast_v", start: 0, duration: 90, sourceIn: 1 } });
  return { p: r.project, clipId: r.result.clipId };
}
const clipOf = (p: Project, id: string) => findClip(p, id)!.clip as Clip & { type: "media" };

describe("speed ramps", () => {
  it("integrates the speed curve frame by frame", () => {
    let { p, clipId } = setup();
    p = applyCommand(p, "clip.setSpeedRamp", { clipId, ramp: [{ frame: 0, value: 1, easing: "linear" }, { frame: 30, value: 3, easing: "linear" }] }).project;
    const c = clipOf(p, clipId);
    expect(speedAt(c, 0)).toBe(1);
    expect(speedAt(c, 15)).toBeCloseTo(2);
    expect(speedAt(c, 60)).toBe(3); // constant after the last key
    // Average speed over the first 30 frames is 2 → 2 s of source.
    expect(sourceOffset(c, 0, 30, 30)).toBeCloseTo(2, 6);
    expect(sourceOffset(c, 30, 60, 30)).toBeCloseTo(3, 6);
    expect(sourceOffset(c, 30, 0, 30)).toBeCloseTo(-2, 6);
    // Plan positions follow the ramp.
    const plan = buildCompositionPlan(p, { rangeStart: 30, rangeEnd: 31 });
    expect(plan.layers[0]!.sourceStart).toBeCloseTo(3, 6);
    expect(plan.layers[0]!.speed).toBe(3);
  });

  it("clamps the clip to its source and mutes its own audio", () => {
    let { p, clipId } = setup(5); // 4 s left after sourceIn 1
    p = applyCommand(p, "clip.setSpeedRamp", { clipId, ramp: "speedUp" }).project;
    const c = clipOf(p, clipId);
    expect(sourceOffset(c, 0, c.duration, 30)).toBeLessThanOrEqual(4 + 1e-6);
    expect(c.duration).toBe(maxClipDuration(p, c));
    expect(validateProject(p).filter((i) => i.severity === "error")).toEqual([]);
    const plan = buildCompositionPlan(p);
    expect(plan.audio.some((a) => a.clip.id === clipId)).toBe(false);
    expect(plan.warnings.join(" ")).toMatch(/muted during the speed ramp/);
  });

  it("split keeps source continuity and the ramp shape", () => {
    let { p, clipId } = setup();
    p = applyCommand(p, "clip.setSpeedRamp", { clipId, ramp: [{ frame: 0, value: 0.5, easing: "linear" }, { frame: 90, value: 2.5, easing: "linear" }] }).project;
    const before = clipOf(p, clipId);
    const srcAt45 = before.sourceIn + sourceOffset(before, 0, 45, 30);
    const r = applyCommand(p, "clip.split", { clipId, frame: 45 });
    const left = clipOf(r.project, r.result.leftId);
    const right = clipOf(r.project, r.result.rightId);
    expect(right.sourceIn).toBeCloseTo(srcAt45, 3);
    expect(speedAt(right, 0)).toBeCloseTo(speedAt(before, 45), 6);
    expect(speedAt(left, 45)).toBeCloseTo(speedAt(before, 45), 6);
    expect(speedAt(right, 20)).toBeCloseTo(speedAt(before, 65), 6);
  });

  it("offers presets, rejects bad targets and clears in one step", () => {
    let { p, clipId } = setup();
    for (const preset of SPEED_RAMP_PRESETS) {
      const r = applyCommand(p, "clip.setSpeedRamp", { clipId, ramp: preset });
      expect(clipOf(r.project, clipId).keyframes.speed!.length).toBeGreaterThan(1);
    }
    expect(() => applyCommand(p, "clip.setSpeedRamp", { clipId, ramp: [{ frame: 0, value: 40, easing: "linear" }] })).toThrow();
    const titles = p.tracks.find((t) => t.kind === "text")!.id;
    const t = applyCommand(p, "clip.add", { trackId: titles, clip: { type: "text", text: "Hi", start: 0, duration: 30 } });
    expect(() => applyCommand(t.project, "keyframe.set", { clipId: t.result.clipId, property: "speed", keyframe: { frame: 0, value: 2, easing: "linear" } })).toThrow(/video/);
    p = applyCommand(p, "clip.setSpeedRamp", { clipId, ramp: "montage" }).project;
    p = applyCommand(p, "clip.setSpeedRamp", { clipId, ramp: null }).project;
    expect(clipOf(p, clipId).keyframes.speed).toBeUndefined();
  });
});
