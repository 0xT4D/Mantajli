// Dev utility: render one frame of a scene template to inspect look changes.
// Usage: npx tsx scripts/render-scene-sample.ts <template> <outDir> [frame]
import { applyCommand, createProject } from "@mantagli/core";
import { Engine } from "@mantagli/engine";
import { renderSceneFrames } from "../packages/engine/src/render/blender.ts";

const [template = "chromeTitle", out = "scene-sample", frame = "12"] = process.argv.slice(2);
const engine = new Engine();
await engine.init();
let p = createProject({ name: "sample", format: "landscape", fps: { num: 24, den: 1 } });
p = applyCommand(p, "scene.create", { name: "Sample", durationFrames: 24, template: template as "chromeTitle", text: "MANTAGLI", ...(process.env.FOG ? { fog: Number(process.env.FOG) } : {}) }).project;
const res = await renderSceneFrames(
  { project: p, scene: p.scenes[0]!, quality: "final", resolutionScale: 0.5, defaultFont: "C:\Windows\Fonts\ariblk.ttf" },
  { blender: engine.blender, outputDir: out, frames: [Number(frame)] },
);
console.log(JSON.stringify(res));
