import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findClip, projectDuration } from "@mantagli/core";
import { Engine } from "../src/engine.js";
import { ProjectSession } from "../src/session.js";
import { exists } from "../src/util/fsx.js";
import { run } from "../src/util/proc.js";
import { makeFixtures, TMP } from "./fixtures.js";

/**
 * Acceptance test: real FFmpeg and Blender, no mocks. Creates a project,
 * imports media, edits the timeline, renders a 3D scene, previews, exports
 * and verifies the result.
 */
// Must be set before any Engine is constructed (settings path is resolved then).
process.env.MANTAGLI_HOME = path.join(TMP, "home");

describe("end-to-end pipeline", () => {
  const engine = new Engine();
  let media: Awaited<ReturnType<typeof makeFixtures>>;
  const projectsDir = path.join(TMP, "projects");

  beforeAll(async () => {
    media = await makeFixtures();
    await rm(projectsDir, { recursive: true, force: true });
    await engine.init();
    expect(engine.deps.ffmpeg, engine.deps.problems.join("\n")).toBeDefined();
  });

  afterAll(async () => {
    await engine.closeProject();
  });

  it("creates, imports and analyses media", async () => {
    const s = await engine.createProject({ name: "E2E Montage", format: "landscape", fps: { num: 24, den: 1 }, parentDir: projectsDir });
    // Small output for test speed.
    s.dispatch("project.setSettings", { width: 640, height: 360 });
    const r = await engine.importMedia([media.video, media.video2, media.music, media.image, path.join(TMP, "nope.mp4")]);
    expect(r.imported.map((a) => a.kind).sort()).toEqual(["audio", "image", "video", "video"]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.category).toBe("not_found");
    const again = await engine.importMedia([media.video]);
    expect(again.duplicates).toHaveLength(1);

    const video = r.imported.find((a) => a.name === "clip_a.mp4")!;
    expect(video.meta).toMatchObject({ width: 1280, height: 720, hasAudio: true });
    expect(video.meta.duration).toBeCloseTo(6, 0);
    await engine.ensureDerived(video.id);
    const updated = engine.project.assets.find((a) => a.id === video.id)!;
    expect(updated.derived.thumbnail && (await exists(s.resolveInProject(updated.derived.thumbnail)))).toBe(true);
    expect(updated.derived.proxy && (await exists(s.resolveInProject(updated.derived.proxy)))).toBe(true);
    expect(updated.derived.waveform).toBeTruthy();
  });

  it("detects the tempo of a 120 BPM track", async () => {
    const music = engine.project.assets.find((a) => a.kind === "audio")!;
    const s = engine.requireSession();
    const musicTrack = s.project.tracks.find((t) => t.role === "music")!;
    s.dispatch("clip.add", { trackId: musicTrack.id, clip: { type: "media", assetId: music.id, start: 0, duration: 8 * 24 } });
    const { analysis, markers } = await engine.analyzeBeats(music.id);
    expect(Math.abs(analysis.bpm - 120)).toBeLessThan(3);
    expect(markers!.beats).toBeGreaterThanOrEqual(14);
    // Beats every 0.5 s = 12 frames at 24 fps.
    const frames = engine.project.markers.filter((m) => m.kind === "beat" || m.kind === "downbeat").map((m) => m.frame);
    const gaps = frames.slice(1).map((f, i) => f - frames[i]!);
    const median = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
    expect(median).toBe(12);
  });

  it("builds a multitrack edit with transitions, text, effects and a 3D scene, and exports it", async () => {
    const s = engine.requireSession();
    const p = s.project;
    const [a, b] = p.assets.filter((x) => x.kind === "video");
    const img = p.assets.find((x) => x.kind === "image")!;
    const v1 = p.tracks.find((t) => t.name === "V1")!.id;
    const v2 = p.tracks.find((t) => t.name === "V2")!.id;
    const titles = p.tracks.find((t) => t.name === "Titles")!.id;

    const scene = s.dispatch("scene.create", { name: "Title 3D", durationFrames: 24, template: "chromeTitle", text: "MANTAGLI", particles: true });
    s.dispatch("scene.update", { sceneId: scene.sceneId, render: { samples: 8, motionBlur: false } });

    s.transaction("Build edit", "user", (tx) => {
      tx.dispatch("clip.add", { trackId: v1, clip: { type: "scene", sceneId: scene.sceneId, start: 0, duration: 24 } });
      const c1 = tx.dispatch("clip.add", { trackId: v1, clip: { type: "media", assetId: a!.id, start: 24, duration: 48, sourceIn: 1 } });
      const c2 = tx.dispatch("clip.add", { trackId: v1, clip: { type: "media", assetId: b!.id, start: 72, duration: 48, speed: 1.5 } });
      tx.dispatch("clip.setTransition", { clipId: c1.clipId, transition: { type: "flash", duration: 8 } });
      tx.dispatch("clip.setTransition", { clipId: c2.clipId, transition: { type: "crossfade", duration: 12 } });
      tx.dispatch("effect.add", { clipId: c1.clipId, type: "basicColor", params: { contrast: 1.2, saturation: 1.3 } });
      tx.dispatch("effect.add", { clipId: c2.clipId, type: "glow", params: { strength: 0.4 } });
      tx.dispatch("effect.add", { clipId: c2.clipId, type: "temperature", params: { warmth: 0.5 } });
      tx.dispatch("keyframe.set", { clipId: c2.clipId, property: "scale", keyframe: { frame: 0, value: 1 } });
      tx.dispatch("keyframe.set", { clipId: c2.clipId, property: "scale", keyframe: { frame: 47, value: 1.25 } });
      const im = tx.dispatch("clip.add", { trackId: v2, clip: { type: "media", assetId: img.id, start: 96, duration: 24 } });
      tx.dispatch("clip.update", { clipId: im.clipId, props: { transform: { scale: 0.4, x: 180, y: -60, rotation: 10, fit: "fit" }, fadeIn: 6 } });
      const t = tx.dispatch("clip.add", { trackId: titles, clip: { type: "text", text: "NIGHT CITY", start: 30, duration: 40, style: { fontSize: 64 }, animation: { in: "pop", out: "slideUp" } } });
      tx.dispatch("effect.add", { clipId: t.clipId, type: "glow", params: { strength: 0.5 } });
    });
    expect(projectDuration(s.project)).toBe(192); // music clip is 8 s

    // Undo / redo of the whole transaction.
    const built = s.project;
    s.undo();
    expect(s.project.tracks.find((t) => t.id === v1)!.clips).toHaveLength(0);
    s.redo();
    expect(s.project).toEqual(built);

    // Preview frame inside the 3D scene (Blender draft render) and inside footage.
    if (engine.deps.blender) {
      const still = await engine.renderStill(10, { scale: 0.5 });
      expect(await exists(still.path)).toBe(true);
    }
    const still2 = await engine.renderStill(80, { scale: 0.5 });
    expect(await exists(still2.path)).toBe(true);
    const cached = await engine.renderStill(80, { scale: 0.5 });
    expect(cached.cached).toBe(true);

    const pre = engine.validateRender();
    expect(pre.issues.filter((i) => i.severity === "error"), JSON.stringify(pre.issues)).toEqual([]);

    const { promise } = engine.startExport({ outPath: path.join(s.dir, "exports", "e2e.mp4"), preset: "landscape1080" });
    const result = await promise;
    expect(result.check.ok).toBe(true);
    // landscape1080 preset scales the 640x360 project to 1920x1080
    expect(result.check.width).toBe(1920);
    expect(result.check.height).toBe(1080);
    expect(result.check.duration!).toBeCloseTo(8, 1);
    expect(result.check.hasAudio).toBe(true);

    // A frame from the flash transition region should be bright; check mean luma via ffmpeg signalstats.
    const r = await run("ffmpeg", ["-hide_banner", "-v", "info", "-ss", String(28 / 24), "-i", result.outPath, "-frames:v", "1", "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-"], { timeoutMs: 30000 });
    const yavg = Number(/YAVG=([\d.]+)/.exec(r.stderr + r.stdout)?.[1]);
    expect(yavg).toBeGreaterThan(120);

    // The 3D title (frames 0-23) must contain lit content, not a black frame.
    if (engine.deps.blender) {
      const r3d = await run("ffmpeg", ["-hide_banner", "-v", "info", "-ss", String(12 / 24), "-i", result.outPath, "-frames:v", "1", "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YMAX", "-f", "null", "-"], { timeoutMs: 30000 });
      const ymax = Number(/YMAX=([\d.]+)/.exec(r3d.stderr + r3d.stdout)?.[1]);
      expect(ymax).toBeGreaterThan(150);
    }
  });

  it("saves, reopens and recovers from a corrupt project file", async () => {
    const s = engine.requireSession();
    const dir = s.dir;
    const clipCount = s.project.tracks.reduce((n, t) => n + t.clips.length, 0);
    await s.save({ backup: true });
    await engine.closeProject();

    const reopened = await engine.openProject(dir);
    expect(reopened.project.tracks.reduce((n, t) => n + t.clips.length, 0)).toBe(clipCount);
    await reopened.save({ backup: true });
    await engine.closeProject();

    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "project.json"), "{ corrupt");
    const recovered = await ProjectSession.open(dir);
    expect(recovered.recoveredFrom).toBeTruthy();
    expect(recovered.project.tracks.reduce((n, t) => n + t.clips.length, 0)).toBe(clipCount);
    await recovered.close();
    await engine.openProject(dir);
  });

  it("detects missing media on open", async () => {
    const s = engine.requireSession();
    const dir = s.dir;
    const img = s.project.assets.find((a) => a.kind === "image")!;
    const { copyFile } = await import("node:fs/promises");
    const moved = path.join(TMP, "moved.png");
    await copyFile(img.path, moved);
    s.dispatch("asset.update", { assetId: img.id, patch: { path: moved, relativePath: "../does-not-exist.png" } });
    await engine.closeProject();
    await rm(moved);
    const again = await engine.openProject(dir);
    expect(again.project.assets.find((a) => a.id === img.id)!.status).toBe("missing");
    const clip = again.project.tracks.flatMap((t) => t.clips).find((c) => c.type === "media" && c.assetId === img.id)!;
    expect(findClip(again.project, clip.id)).toBeDefined();
    await engine.relinkAsset(img.id, media.image);
    expect(engine.project.assets.find((a) => a.id === img.id)!.status).toBe("ok");
  });
});
