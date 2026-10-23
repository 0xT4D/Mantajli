import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TMP } from "./fixtures.js";

process.env.MANTAGLI_HOME = path.join(TMP, "home-autorender");
const { Engine } = await import("../src/engine.js");
const { existingFrames } = await import("../src/render/blender.js");

const engine = new Engine();
afterAll(async () => {
  await engine.closeProject();
});

async function until(fn: () => boolean | Promise<boolean>, ms = 120_000) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("automatic 3D previews", () => {
  it("re-renders draft frames after scene edits, superseding stale jobs", async () => {
    await engine.init();
    if (!engine.deps.blender) return;
    engine.sceneAutoDelayMs = 150;
    await engine.config.update({ previewScale: 0.25, autoRenderScenes: true });
    const dir = path.join(TMP, "autorender");
    await rm(dir, { recursive: true, force: true });
    const s = await engine.createProject({ name: "Auto", format: "square", parentDir: dir });
    const sc = s.dispatch("scene.create", { name: "Logo", template: "chromeTitle", durationFrames: 6, text: "A", particles: false });
    s.dispatch("scene.update", { sceneId: sc.sceneId, render: { samples: 4, motionBlur: false, bloom: false } });

    // Not on the timeline yet: nothing should render.
    await new Promise((r) => setTimeout(r, 400));
    expect(engine.jobs.list().filter((j) => j.type === "scene")).toHaveLength(0);

    const v1 = s.project.tracks.find((t) => t.name === "V1")!.id;
    s.dispatch("clip.add", { trackId: v1, clip: { type: "scene", sceneId: sc.sceneId, start: 0 } });
    await until(() => engine.jobs.list().some((j) => j.type === "scene"));
    const first = engine.jobs.list().find((j) => j.type === "scene")!;

    // A quick second edit supersedes the first job.
    s.dispatch("scene.update", { sceneId: sc.sceneId, world: { color: "#200010" } });
    await until(() => engine.jobs.list().filter((j) => j.type === "scene").length >= 2);
    await until(() => ["cancelled", "done"].includes(engine.jobs.get(first.id)!.status));
    const latest = engine.jobs.list().find((j) => j.type === "scene" && j.id !== first.id)!;
    await until(() => engine.jobs.get(latest.id)!.status === "done");
    const { dir: cacheDir } = engine.sceneCacheDir(sc.sceneId, "draft", 0.25);
    expect((await existingFrames(cacheDir)).size).toBe(6);

    // Up to date: another unrelated edit queues nothing new.
    const count = engine.jobs.list().filter((j) => j.type === "scene").length;
    s.dispatch("project.rename", { name: "Auto 2" });
    await new Promise((r) => setTimeout(r, 600));
    expect(engine.jobs.list().filter((j) => j.type === "scene")).toHaveLength(count);

    // Exports cancel pending auto previews.
    s.dispatch("scene.update", { sceneId: sc.sceneId, world: { color: "#002010" } });
    await until(() => engine.jobs.list().filter((j) => j.type === "scene").length > count);
    const pending = engine.jobs.list().find((j) => j.type === "scene" && (j.status === "running" || j.status === "queued"))!;
    engine.cancelSceneAutoRenders();
    await until(() => engine.jobs.get(pending.id)!.status === "cancelled");
  });
});
