import { describe, expect, it } from "vitest";
import {
  AssetSchema,
  History,
  lookSpec,
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

describe("camera moves and scene object edits", () => {
  it("builds an orbit path with snap-and-settle progress keys and can remove it again", () => {
    let p = createProject({ name: "Cam", format: "vertical" });
    const sc = run(p, "scene.create", { name: "S", durationFrames: 90, template: "empty" });
    p = sc.project;
    const scene = () => p.scenes[0]!;
    const camId = scene().objects.find((o) => o.kind === "camera")!.id;
    const hero = run(p, "scene.addObject", { sceneId: sc.result.sceneId, object: { kind: "mesh", name: "Hero", location: [1, 2, 0.5] } });
    p = hero.project;
    p = run(p, "scene.cameraMove", { sceneId: sc.result.sceneId, cameraId: camId, move: "orbit", targetId: hero.result.objectId, distance: 5, height: 1, arc: 180, easing: "expoOut", stops: [30, 60], stepFrames: 12 }).project;
    const cam = scene().objects.find((o) => o.id === camId)!;
    expect(cam.camera!.trackTargetId).toBe(hero.result.objectId);
    expect(cam.location).toEqual([0, 0, 0]);
    // Points sit on the circle of radius 5 around the target, 1 m above it.
    for (const [x, y, z] of cam.path!.points) {
      expect(Math.hypot(x - 1, y - 2)).toBeCloseTo(5, 2);
      expect(z).toBeCloseTo(1.5, 5);
    }
    expect(cam.animation.find((a) => a.property === "pathProgress")!.keyframes).toEqual([
      { frame: 30, value: [0], easing: "expoOut" },
      { frame: 42, value: [0.5], easing: "hold" },
      { frame: 60, value: [0.5], easing: "expoOut" },
      { frame: 72, value: [1], easing: "hold" },
    ]);
    // Moves that would run past the scene end are rejected.
    expect(() => run(p, "scene.cameraMove", { sceneId: sc.result.sceneId, cameraId: camId, move: "dollyIn", stops: [85], stepFrames: 20 })).toThrow(/beyond the scene/);
    // Unset removes optional settings that a patch cannot express.
    p = run(p, "scene.updateObject", { sceneId: sc.result.sceneId, objectId: camId, unset: ["path", "camera.trackTargetId"] }).project;
    const after = scene().objects.find((o) => o.id === camId)!;
    expect(after.path).toBeUndefined();
    expect(after.camera!.trackTargetId).toBeUndefined();
    expect(after.animation.some((a) => a.property === "pathProgress")).toBe(false);
  });

  it("fills the frame with a portal screen like a fill-fit clip", async () => {
    const { fillDistance } = await import("../src/index.js");
    // 16:9 screen in a 9:16 frame at 32 mm: heights match (vertical FOV from the 36 mm sensor across the height).
    const d = fillDistance(1.6, 0.9, 32, 9 / 16);
    expect(0.9 / 2 / d).toBeCloseTo(18 / 32, 6);
    // 4:3 screen in a 16:9 frame: widths match.
    const d2 = fillDistance(1.2, 0.9, 32, 16 / 9);
    expect(1.2 / 2 / d2).toBeCloseTo(18 / 32, 6);
  });
});

describe("copy and paste", () => {
  it("pastes clips at a frame keeping relative timing and tracks, with fresh ids", () => {
    let { p, assetId } = withAsset(createProject({ name: "CP" }), "video", 20);
    const a = run(p, "clip.add", { trackId: v1(p), clip: { type: "media", assetId, start: 0, duration: 30 } });
    const t = a.project.tracks.find((x) => x.name === "Titles")!.id;
    const b = run(a.project, "clip.add", { trackId: t, clip: { type: "text", text: "HI", start: 10, duration: 20 } });
    p = b.project;
    const items = p.tracks.flatMap((tr) => tr.clips.map((clip) => ({ trackId: tr.id, clip })));
    const r = run(p, "clip.paste", { items, at: 100 });
    const pasted = r.project.tracks.flatMap((tr) => tr.clips.filter((c) => r.result.clipIds.includes(c.id)).map((c) => ({ track: tr.name, start: c.start, id: c.id })));
    expect(pasted.map(({ track, start }) => ({ track, start })).sort((x, y) => x.start - y.start)).toEqual([
      { track: "V1", start: 100 },
      { track: "Titles", start: 110 },
    ]);
    expect(pasted.every((x) => !items.some((i) => i.clip.id === x.id))).toBe(true);
    // A deleted source track falls back to the first track of the same kind.
    const gone = run(r.project, "track.remove", { trackId: t, force: true } as never).project;
    const textItem = items.find((i) => i.clip.type === "text")!;
    const withText = run(gone, "track.add", { kind: "text", name: "T2" }).project;
    const r2 = run(withText, "clip.paste", { items: [textItem], at: 200 });
    expect(r2.project.tracks.find((tr) => tr.clips.some((c) => c.id === r2.result.clipIds[0]))!.name).toBe("T2");
    expect(() => run(gone, "clip.paste", { items: [textItem], at: 200 })).toThrow(/No track/);
    // Media from another project is rejected.
    const media = items.find((i) => i.clip.type === "media")!;
    const other = { trackId: v1(p), clip: { ...media.clip, assetId: "ast_missing" } as typeof media.clip };
    expect(() => run(p, "clip.paste", { items: [other], at: 0 })).toThrow(/not in this project/);
  });
});

describe("saved looks", () => {
  it("saves a clip's enabled effects as a reusable look, replaces by name and removes", () => {
    let p = createProject({ name: "L" });
    const c = run(p, "clip.add", { trackId: v1(p), clip: { type: "color", fill: "#808080", start: 0, duration: 30 } });
    p = run(c.project, "effect.add", { clipId: c.result.clipId, type: "scanlines", params: { amount: 0.3 } }).project;
    const off = run(p, "effect.add", { clipId: c.result.clipId, type: "grain", params: {} });
    p = run(off.project, "effect.update", { clipId: c.result.clipId, effectId: off.result.effectId, enabled: false }).project;
    const saved = run(p, "look.save", { clipId: c.result.clipId, label: "My CRT" });
    p = saved.project;
    expect(p.looks).toHaveLength(1);
    expect(p.looks[0]!.effects.map((e) => e.type)).toEqual(["scanlines"]); // disabled grain left out
    // Same name replaces; built-in names are reserved.
    p = run(p, "look.save", { clipId: c.result.clipId, label: "my crt" }).project;
    expect(p.looks).toHaveLength(1);
    expect(() => run(p, "look.save", { clipId: c.result.clipId, label: "Noir" })).toThrow(/built-in/);
    expect(lookSpec(saved.result.lookId, p.looks)?.label).toBe("my crt");
    p = run(p, "look.remove", { lookId: saved.result.lookId }).project;
    expect(p.looks).toHaveLength(0);
  });
});
