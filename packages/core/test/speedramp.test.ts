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

describe("auto edit to beats", () => {
  it("cuts every N beats, rotates assets, advances in-points and wraps", async () => {
    let { p } = setup(2.5); // 2.5 s video, plus a clip from setup on V1 (replaced below)
    const img = AssetSchema.parse({ id: "ast_img", kind: "image", name: "i.png", path: "C:/media/i.png", size: 1, hash: "i", importedAt: new Date().toISOString(), meta: { width: 800, height: 800, hasVideo: true, hasAudio: false } });
    p = applyCommand(p, "asset.add", { asset: img }).project;
    for (let f = 0; f <= 300; f += 15) p = applyCommand(p, "marker.add", { frame: f, kind: f % 60 === 0 ? "downbeat" : "beat" }).project;
    const v2 = p.tracks.find((t) => t.name === "V2")!.id;
    const r = applyCommand(p, "timeline.autoEdit", {
      trackId: v2,
      assetIds: ["ast_v", "ast_v", "ast_img"],
      start: 10,
      end: 160,
      every: 2,
      transition: { type: "crossfade", duration: 6 },
      look: "cyberpunk",
      pulse: 0.1,
    });
    const clips = r.project.tracks.find((t) => t.id === v2)!.clips;
    // Beats after 10: 15,30,45,...; every 2nd → cuts at 30, 60, 90, 120, 150.
    expect(clips.map((c) => [c.start, c.duration])).toEqual([[10, 20], [30, 30], [60, 30], [90, 30], [120, 30], [150, 10]]);
    const media = clips.map((c) => (c.type === "media" ? [c.assetId, Math.round(c.sourceIn * 1000) / 1000] : null));
    // Same video twice in a row continues; 0.667 + 1 + 1 > 2.5 s wraps back to 0.
    expect(media).toEqual([["ast_v", 0], ["ast_v", 0.667], ["ast_img", 0], ["ast_v", 0], ["ast_v", 1], ["ast_img", 0]]);
    expect(clips[0]!.transitionIn).toBeNull();
    expect(clips[1]!.transitionIn).toEqual({ type: "crossfade", duration: 6 });
    expect(clips[1]!.effects.map((e) => e.type)).toContain("beatPulse");
    expect(clips[1]!.effects.length).toBeGreaterThan(2);
    // Downbeats only: 60, 120 (every 1).
    const d = applyCommand(p, "timeline.autoEdit", { trackId: v2, assetIds: ["ast_img"], start: 0, end: 150, every: 1, on: "downbeats" });
    expect(d.project.tracks.find((t) => t.id === v2)!.clips.map((c) => c.start)).toEqual([0, 60, 120]);
    expect(() => applyCommand(p, "timeline.autoEdit", { trackId: v2, assetIds: ["ast_img"], start: 1000, end: 1100 })).toThrow(/No beats markers/);
  });
});

describe("reverse and freeze", () => {
  const fps = 30;
  it("maps reversed frames, keeps continuity across trims and splits", async () => {
    const { sourceTimeAt } = await import("../src/index.js");
    let { p, clipId } = setup(); // 90 frames from sourceIn 1 s at 30 fps
    p = applyCommand(p, "clip.update", { clipId, props: { reverse: true } }).project;
    const c = clipOf(p, clipId);
    expect(sourceTimeAt(c, 0, fps)).toBeCloseTo(1 + 89 / 30);
    expect(sourceTimeAt(c, 89, fps)).toBeCloseTo(1);
    const shown = (q: Project, id: string, f: number) => sourceTimeAt(clipOf(q, id), f, fps);
    // Split at timeline frame 30: both halves show exactly what the whole clip showed.
    const s = applyCommand(p, "clip.split", { clipId, frame: 30 });
    expect(shown(s.project, s.result.leftId, 0)).toBeCloseTo(shown(p, clipId, 0));
    expect(shown(s.project, s.result.leftId, 29)).toBeCloseTo(shown(p, clipId, 29));
    expect(shown(s.project, s.result.rightId, 0)).toBeCloseTo(shown(p, clipId, 30));
    expect(shown(s.project, s.result.rightId, 59)).toBeCloseTo(shown(p, clipId, 89));
    // Trimming the end of a reversed clip keeps the frames that remain.
    const t = applyCommand(p, "clip.trim", { clipId, edge: "end", frame: 60 }).project;
    expect(shown(t, clipId, 0)).toBeCloseTo(shown(p, clipId, 0));
    expect(shown(t, clipId, 59)).toBeCloseTo(shown(p, clipId, 59));
    // Trimming the start too.
    const ts = applyCommand(p, "clip.trim", { clipId, edge: "start", frame: 10 }).project;
    expect(shown(ts, clipId, 0)).toBeCloseTo(shown(p, clipId, 10));
    expect(() => applyCommand(p, "clip.setSpeedRamp", { clipId, ramp: "montage" })).toThrow(/reverse or freeze/);
  });

  it("inserts a freeze frame and ripples the rest of the track", async () => {
    const { sourceTimeAt, buildCompositionPlan } = await import("../src/index.js");
    let { p, clipId } = setup();
    const v1 = p.tracks.find((t) => t.name === "V1")!.id;
    p = applyCommand(p, "clip.add", { trackId: v1, clip: { type: "media", assetId: "ast_v", start: 120, duration: 30 } }).project;
    const r = applyCommand(p, "clip.freezeFrame", { clipId, frame: 40, duration: 15 });
    const clips = r.project.tracks.find((t) => t.id === v1)!.clips;
    expect(clips.map((c) => [c.start, c.duration])).toEqual([[0, 40], [40, 15], [55, 50], [135, 30]]);
    const still = clips[1]!;
    expect(still.type === "media" && still.freeze).toBe(true);
    expect(sourceTimeAt(still, 0, fps)).toBeCloseTo(sourceTimeAt(clipOf(p, clipId), 40, fps));
    expect(sourceTimeAt(still, 14, fps)).toBeCloseTo(sourceTimeAt(still, 0, fps));
    // Freeze frames are silent.
    const plan = buildCompositionPlan(r.project, { rangeStart: 45, rangeEnd: 46 });
    expect(plan.audio.some((a) => a.clip.id === still.id)).toBe(false);
  });
});
