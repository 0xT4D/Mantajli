// Dev utility: chrome sphere in the reflection-band world.
import { applyCommand, createProject } from "@mantagli/core";
import { Engine } from "@mantagli/engine";
import { renderSceneFrames } from "../packages/engine/src/render/blender.ts";
const [out = "sphere", refl = "4", engineName = "eevee"] = process.argv.slice(2);
const engine = new Engine();
await engine.init();
let p = createProject({ name: "s", format: "landscape", fps: { num: 24, den: 1 } });
const r = applyCommand(p, "scene.create", { name: "S", durationFrames: 2, template: "empty" });
p = r.project;
const sceneId = r.result.sceneId;
p = applyCommand(p, "scene.addObject", { sceneId, object: { kind: "mesh", name: "Ball", mesh: { primitive: "sphere", size: 3, smooth: true }, material: { preset: "chrome", baseColor: "#e8e8f0", metallic: 1, roughness: 0.05, emissionColor: "#000000", emissionStrength: 0, transmission: 0 } } }).project;
p = applyCommand(p, "scene.update", { sceneId, world: { reflections: Number(refl), color: "#05050a" }, render: { engine: engineName as "eevee", samples: 16 } }).project;
const res = await renderSceneFrames({ project: p, scene: p.scenes[0]!, quality: "final", resolutionScale: 0.3 }, { blender: engine.blender, outputDir: out, frames: [1] });
console.log(JSON.stringify(res));
