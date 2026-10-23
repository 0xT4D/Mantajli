import { describe, expect, it } from "vitest";
import {
  AssetSchema,
  History,
  applyCommand,
  buildCompositionPlan,
  createProject,
  findClip,
  migrateProject,
  summarizeProject,
  validateProject,
  type CommandName,
  type CommandParams,
  type Project,
} from "../src/index.js";

function withAsset(p: Project, kind: "video" | "audio" | "image" = "video", duration = 10): { p: Project; assetId: string } {
  const asset = AssetSchema.parse({
    id: `ast_${kind}${duration}`,
    kind,
    name: `${kind}.mp4`,
    path: `C:/media/${kind}.mp4`,
    size: 1000,
    hash: "x",
    importedAt: new Date().toISOString(),
    meta: { duration, width: 1920, height: 1080, fps: { num: 30, den: 1 }, hasVideo: kind !== "audio", hasAudio: kind !== "image" },
  });
  const r = applyCommand(p, "asset.add", { asset });
  return { p: r.project, assetId: asset.id };
}

function run<N extends CommandName>(p: Project, name: N, params: CommandParams<N>) {
  return applyCommand(p, name, params);
}

const v1 = (p: Project) => p.tracks.find((t) => t.name === "V1")!.id;
const music = (p: Project) => p.tracks.find((t) => t.role === "music")!.id;

describe("project model", () => {
  it("creates a valid vertical project with default tracks", () => {
    const p = createProject({ name: "Test" });
    expect(p.settings).toMatchObject({ width: 1080, height: 1920 });
    expect(p.tracks.map((t) => t.kind)).toEqual(["text", "video", "video", "audio", "audio"]);
    expect(validateProject(p)).toEqual([]);
  });

  it("round-trips through JSON and migration", () => {
    const p = createProject({ name: "RT", format: "landscape" });
    const { project } = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(project).toEqual(p);
    const legacy = { ...JSON.parse(JSON.stringify(p)) };
    delete legacy.schemaVersion;
    expect(migrateProject(legacy).migratedFrom).toBe(0);
    expect(() => migrateProject({ ...p, schemaVersion: 99 })).toThrow(/newer/);
  });
});

describe("timeline commands", () => {
  it("adds a media clip clamped to source length", () => {
    let { p, assetId } = withAsset(createProject({ name: "T" }), "video", 4);
    const r = run(p, "clip.add", { trackId: v1(p), clip: { type: "media", assetId, start: 10 } });
    expect(r.result.duration).toBe(120); // 4s @ 30fps
    p = r.project;
    const ref = findClip(p, r.result.clipId)!;
    expect(ref.clip.start).toBe(10);
  });

  it("rejects audio assets on video tracks and video-less assets on audio tracks", () => {
    let { p, assetId } = withAsset(createProject({ name: "T" }), "audio", 30);
    expect(() => run(p, "clip.add", { trackId: v1(p), clip: { type: "media", assetId, start: 0 } })).toThrow(/audio track/);
    const img = withAsset(p, "image");
    expect(() => run(img.p, "clip.add", { trackId: music(img.p), clip: { type: "media", assetId: img.assetId, start: 0 } })).toThrow(/no audio/);
  });

  it("splits, trims and moves with correct source offsets", () => {
    let { p, assetId } = withAsset(createProject({ name: "T" }), "video", 10);
    const add = run(p, "clip.add", { trackId: v1(p), clip: { type: "media", assetId, start: 0, duration: 90 } });
    p = add.project;
    const split = run(p, "clip.split", { clipId: add.result.clipId, frame: 30 });
    p = split.project;
    const left = findClip(p, split.result.leftId)!.clip;
    const right = findClip(p, split.result.rightId)!.clip;
    expect([left.start, left.duration]).toEqual([0, 30]);
    expect([right.start, right.duration]).toEqual([30, 60]);
    expect(right.type === "media" && right.sourceIn).toBe(1);

    p = run(p, "clip.trim", { clipId: right.id, edge: "start", frame: 45 }).project;
    const trimmed = findClip(p, right.id)!.clip;
    expect(trimmed.start).toBe(45);
    expect(trimmed.duration).toBe(45);
    expect(trimmed.type === "media" && trimmed.sourceIn).toBeCloseTo(1.5);

    p = run(p, "clip.move", { clipId: right.id, start: 200 }).project;
    expect(findClip(p, right.id)!.clip.start).toBe(200);
  });

  it("overwrites overlapped clips by default and errors in strict mode", () => {
    let { p, assetId } = withAsset(createProject({ name: "T" }), "video", 20);
    const a = run(p, "clip.add", { trackId: v1(p), clip: { type: "media", assetId, start: 0, duration: 300 } });
    p = a.project;
    expect(() => run(p, "clip.add", { trackId: v1(p), clip: { type: "media", assetId, start: 100, duration: 50 }, mode: "error" })).toThrow(/overlap/);
    const b = run(p, "clip.add", { trackId: v1(p), clip: { type: "media", assetId, start: 100, duration: 50 } });
    p = b.project;
    const track = p.tracks.find((t) => t.id === v1(p))!;
    expect(track.clips.map((c) => [c.start, c.duration])).toEqual([
      [0, 100],
      [100, 50],
      [150, 150],
    ]);
    expect(validateProject(p).filter((i) => i.code === "overlap")).toEqual([]);
  });

  it("ripple-deletes", () => {
    let { p, assetId } = withAsset(createProject({ name: "T" }), "video", 20);
    const a = run(p, "clip.add", { trackId: v1(p), clip: { type: "media", assetId, start: 0, duration: 30 } });
    const b = run(a.project, "clip.add", { trackId: v1(p), clip: { type: "media", assetId, start: 30, duration: 30 } });
    p = run(b.project, "clip.remove", { clipIds: [a.result.clipId], ripple: true }).project;
    expect(findClip(p, b.result.clipId)!.clip.start).toBe(0);
  });

  it("undo/redo restores exact states", () => {
    const h = new History();
    let { p, assetId } = withAsset(createProject({ name: "T" }), "video", 10);
    const s0 = p;
    const r1 = run(p, "clip.add", { trackId: v1(p), clip: { type: "media", assetId, start: 0, duration: 60 } });
    h.record({ label: "add", source: "user", before: p, after: r1.project });
    p = r1.project;
    const r2 = run(p, "clip.move", { clipId: r1.result.clipId, start: 90 });
    h.record({ label: "move", source: "user", before: p, after: r2.project });
    p = r2.project;
    expect(h.undo()!.before).toBe(r1.project);
    expect(h.undo()!.before).toBe(s0);
    expect(h.undo()).toBeUndefined();
    expect(h.redo()!.after).toBe(r1.project);
    expect(h.redo()!.after).toBe(r2.project);
  });

  it("validates effect params and transitions", () => {
    let { p, assetId } = withAsset(createProject({ name: "T" }), "video", 10);
    const a = run(p, "clip.add", { trackId: v1(p), clip: { type: "media", assetId, start: 0, duration: 60 } });
    p = a.project;
    const fx = run(p, "effect.add", { clipId: a.result.clipId, type: "basicColor", params: { contrast: 5 } });
    const clip = findClip(fx.project, a.result.clipId)!.clip;
    expect(clip.effects[0]!.params.contrast).toBe(2); // clamped
    expect(() => run(p, "effect.add", { clipId: a.result.clipId, type: "notAnEffect" as never })).toThrow();
    expect(() => run(p, "clip.setTransition", { clipId: a.result.clipId, transition: { type: "crossfade", duration: 600 } })).toThrow(/longer/);
  });

  it("patches never reset omitted fields to defaults", () => {
    let { p, assetId } = withAsset(createProject({ name: "T" }), "video", 10);
    const a = run(p, "clip.add", { trackId: v1(p), clip: { type: "media", assetId, start: 0, duration: 60 } });
    p = run(a.project, "clip.update", { clipId: a.result.clipId, props: { transform: { x: 100, fit: "fit", crop: { left: 0.1 } } } }).project;
    p = run(p, "clip.update", { clipId: a.result.clipId, props: { transform: { scale: 2, crop: { top: 0.2 } } } }).project;
    const t = findClip(p, a.result.clipId)!.clip.transform;
    expect(t).toMatchObject({ x: 100, scale: 2, fit: "fit", crop: { left: 0.1, top: 0.2 } });
    p = run(p, "asset.update", { assetId, patch: { derived: { thumbnail: "cache/x.jpg" } } }).project;
    const asset = p.assets.find((x) => x.id === assetId)!;
    expect(asset.meta.hasAudio).toBe(true);
    expect(asset.meta.duration).toBe(10);
    p = run(p, "project.setExport", { crf: 20 }).project;
    p = run(p, "project.setExport", { codec: "h265" }).project;
    expect(p.export).toMatchObject({ crf: 20, codec: "h265" });
  });

  it("keeps the input project untouched when a command fails", () => {
    const p = createProject({ name: "T" });
    const json = JSON.stringify(p);
    expect(() => run(p, "clip.move", { clipId: "clip_missing", start: 0 })).toThrow(/not found/);
    expect(JSON.stringify(p)).toBe(json);
  });

  it("re-times frame values when the frame rate changes", () => {
    let { p, assetId } = withAsset(createProject({ name: "T" }), "video", 10);
    p = run(p, "clip.add", { trackId: v1(p), clip: { type: "media", assetId, start: 30, duration: 60 } }).project;
    p = run(p, "project.setSettings", { fps: { num: 60, den: 1 } }).project;
    const c = p.tracks.find((t) => t.id === v1(p))!.clips[0]!;
    expect([c.start, c.duration]).toEqual([60, 120]);
  });
});

describe("scenes", () => {
  it("builds every template into a valid scene with a camera", () => {
    let p = createProject({ name: "S" });
    for (const template of ["chromeTitle", "productTurntable", "neonFlythrough", "particleBackdrop", "empty"] as const) {
      const r = run(p, "scene.create", { name: template, durationFrames: 90, template, text: "HELLO" });
      p = r.project;
      expect(r.result.objectIds.some((o) => o.kind === "camera")).toBe(true);
    }
    expect(validateProject(p).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("validates animation keyframe arity", () => {
    let p = createProject({ name: "S" });
    const r = run(p, "scene.create", { name: "x", durationFrames: 60, template: "empty" });
    p = r.project;
    const cam = r.result.objectIds.find((o) => o.kind === "camera")!.id;
    expect(() => run(p, "scene.animate", { sceneId: r.result.sceneId, objectId: cam, property: "location", keyframes: [{ frame: 0, value: [1] }] })).toThrow(/3 values/);
    const ok = run(p, "scene.animate", { sceneId: r.result.sceneId, objectId: cam, property: "focalLength", keyframes: [{ frame: 0, value: [24] }, { frame: 59, value: [85] }] });
    expect(ok.changed).toBe(true);
  });
});

describe("composition plan", () => {
  it("extends the outgoing clip under a crossfade and layers bottom-up", () => {
    let { p, assetId } = withAsset(createProject({ name: "C" }), "video", 20);
    const a = run(p, "clip.add", { trackId: v1(p), clip: { type: "media", assetId, start: 0, duration: 60 } });
    const b = run(a.project, "clip.add", { trackId: v1(p), clip: { type: "media", assetId, start: 60, duration: 60, sourceIn: 5 } });
    p = run(b.project, "clip.setTransition", { clipId: b.result.clipId, transition: { type: "crossfade", duration: 10 } }).project;
    const t = p.tracks.find((t) => t.name === "Titles")!.id;
    p = run(p, "clip.add", { trackId: t, clip: { type: "text", text: "Hi", start: 0, duration: 30 } }).project;
    const plan = buildCompositionPlan(p);
    expect(plan.layers.map((l) => l.clip.type)).toEqual(["media", "media", "text"]);
    expect(plan.layers[0]!.tail).toBe(10);
    expect(plan.layers[0]!.frames).toBe(70);
    expect(plan.layers[1]!.hasOutgoing).toBe(true);
    // video clips contribute audio
    expect(plan.audio).toHaveLength(2);

    const ranged = buildCompositionPlan(p, { rangeStart: 65, rangeEnd: 75 });
    const second = ranged.layers.find((l) => l.clip.id === b.result.clipId)!;
    expect(second.clipOffset).toBe(5);
    expect(second.sourceStart).toBeCloseTo(5 + 5 / 30);
  });

  it("summarizes for the AI with ids and timings", () => {
    let { p, assetId } = withAsset(createProject({ name: "AI" }), "video", 5);
    p = run(p, "clip.add", { trackId: v1(p), clip: { type: "media", assetId, start: 0 } }).project;
    const s = summarizeProject(p);
    expect(s.project.durationFrames).toBe(150);
    expect(s.tracks.find((t) => t.name === "V1")!.clips[0]).toMatchObject({ assetId, start: 0, duration: 150 });
  });
});
