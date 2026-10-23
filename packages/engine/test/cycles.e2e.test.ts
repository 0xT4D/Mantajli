import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TMP } from "./fixtures.js";

process.env.MANTAGLI_HOME = path.join(TMP, "home-cycles");
const { Engine } = await import("../src/engine.js");
const { executeTool } = await import("../src/ai/tools.js");
const { matchingRenderPreset } = await import("@mantagli/core");

const engine = new Engine();
afterAll(async () => {
  await engine.closeProject();
});

describe("Cycles quality presets", () => {
  it("applies a preset and reports the compute device Blender used", async () => {
    await engine.init();
    const dir = path.join(TMP, "cycles");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await engine.createProject({ name: "Cycles", format: "landscape", parentDir: dir });
    const s = engine.requireSession();
    const sc = s.dispatch("scene.create", { name: "Gold", template: "chromeTitle", durationFrames: 4, text: "C", particles: false });
    const r = await executeTool({ engine, source: "ai" }, "scene_set_render_settings", { sceneId: sc.sceneId, preset: "cyclesPreview" });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    const scene = s.project.scenes[0]!;
    expect(scene.render.engine).toBe("cycles");
    expect(matchingRenderPreset(scene.render)).toBe("cyclesPreview");

    const out = await engine.renderScene(sc.sceneId, { quality: "draft", scale: 0.2, frames: [2] });
    expect(out.rendered).toBe(1);
    const device = engine.deps.blender?.cyclesDevice;
    expect(device).toBeDefined();
    // This machine has an NVIDIA RTX GPU; elsewhere CPU fallback is valid.
    if (process.env.MANTAGLI_EXPECT_GPU !== "0") expect(["OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"]).toContain(device);
  });
});
