// Dev utility: render one timeline frame of a project and keep the FFmpeg work dir.
// Usage: npx tsx scripts/debug-frame.ts <projectDir> <frame> <out.png>
import path from "node:path";
import { buildCompositionPlan } from "@mantagli/core";
import { Engine } from "@mantagli/engine";
import { compose } from "../packages/engine/src/render/compose.ts";

const [dir, frameS, out] = process.argv.slice(2);
const engine = new Engine();
await engine.init();
const s = await engine.openProject(dir!, { force: true });
if (process.env.TEXT_AT) s.dispatch("clip.add", { trackId: s.project.tracks.find((t) => t.name === "Titles")!.id, clip: { type: "text", text: process.env.TEXT ?? "CUT TO\nTHE BEAT", start: Number(process.env.TEXT_AT), duration: 50, style: { fontSize: 72, strokeWidth: 3 }, animation: { in: "pop", out: "fade" } } });
await engine.warmFonts(s.project);
const f = Number(frameS);
const end = Number(process.env.END ?? f + 1);
const plan = buildCompositionPlan(s.project, { rangeStart: f, rangeEnd: end, audio: false });
console.log(plan.layers.map((l) => `${l.clip.type}:${l.clip.id} off=${l.clipOffset} start=${l.start}`).join("\n"));
const r = await compose({
  ffmpeg: engine.ffmpeg, project: s.project, plan, scale: 1, output: end > f + 1 ? "video" : "still", includeAudio: false, outPath: path.resolve(out!), workRoot: path.resolve("tests/.tmp/debug-work"), keepWorkDir: true,
  mediaPath: (a) => a.path, sceneFrames: () => undefined, fontFile: () => "C:/Windows/Fonts/arialbd.ttf",
});
console.log(r);
await engine.closeProject();
