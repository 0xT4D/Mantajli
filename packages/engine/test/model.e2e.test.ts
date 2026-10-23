import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TMP } from "./fixtures.js";

process.env.MANTAGLI_HOME = path.join(TMP, "home-model");
const { Engine } = await import("../src/engine.js");
const { run } = await import("../src/util/proc.js");

/** An octahedron gem as a Wavefront OBJ (real file, imported by Blender). */
const OBJ = `# Mantagli test gem
v 0 0 1.2
v 1 0 0
v 0 1 0
v -1 0 0
v 0 -1 0
v 0 0 -1.2
f 1 2 3
f 1 3 4
f 1 4 5
f 1 5 2
f 6 3 2
f 6 4 3
f 6 5 4
f 6 2 5
`;

const engine = new Engine();
afterAll(async () => {
  await engine.closeProject();
});

describe("3D model import", () => {
  it("imports an OBJ model and renders it in a turntable scene", async () => {
    await engine.init();
    if (!engine.deps.blender) return; // Blender not installed: nothing to verify here
    const dir = path.join(TMP, "model");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const obj = path.join(dir, "gem.obj");
    await writeFile(obj, OBJ);
    await engine.createProject({ name: "Model Test", format: "square", parentDir: dir });
    const r = await engine.importMedia([obj]);
    expect(r.imported[0]?.kind).toBe("model");
    const s = engine.requireSession();
    const scene = s.dispatch("scene.create", { name: "Gem", template: "productTurntable", durationFrames: 30, modelAssetId: r.imported[0]!.id, material: "gold" });
    s.dispatch("scene.update", { sceneId: scene.sceneId, render: { samples: 8, motionBlur: false } });
    const product = scene.objectIds.find((o) => o.name === "Product")!;
    s.dispatch("scene.updateObject", { sceneId: scene.sceneId, objectId: product.id, patch: { material: { preset: "gold", baseColor: "#ffc356", metallic: 1, roughness: 0.2, emissionColor: "#000000", emissionStrength: 0, transmission: 0 } } });

    const out = await engine.renderScene(scene.sceneId, { quality: "draft", scale: 0.3, frames: [8] });
    const frame = path.join(out.dir, "frame_00008.png");
    // The gem must be visible: measure mean and max luma of the centre region.
    const p = await run("ffmpeg", ["-hide_banner", "-v", "info", "-i", frame, "-vf", "crop=iw/2:ih/2,signalstats,metadata=print:key=lavfi.signalstats.YMAX", "-f", "null", "-"], { timeoutMs: 30000 });
    const ymax = Number(/YMAX=([\d.]+)/.exec(p.stderr)?.[1]);
    expect(ymax).toBeGreaterThan(120);
  });
});
