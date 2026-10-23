// Dev utility: build a demo project from the generated test media.
// Usage: npx tsx scripts/make-demo.ts <parentDir>
import path from "node:path";
import { Engine } from "@mantagli/engine";
import { makeFixtures } from "../packages/engine/test/fixtures.ts";

const parent = path.resolve(process.argv[2] ?? "tests/.tmp/demo");
const media = await makeFixtures();
const engine = new Engine();
await engine.init();
const s = await engine.createProject({ name: `Demo ${Date.now() % 100000}`, format: "vertical", fps: { num: 30, den: 1 }, parentDir: parent });
const r = await engine.importMedia([media.video, media.video2, media.music, media.image]);
for (const a of r.imported) await engine.ensureDerived(a.id);
const [a, b] = r.imported.filter((x) => x.kind === "video");
const music = r.imported.find((x) => x.kind === "audio")!;
const p = s.project;
const v1 = p.tracks.find((t) => t.name === "V1")!.id;
const titles = p.tracks.find((t) => t.name === "Titles")!.id;
const mus = p.tracks.find((t) => t.role === "music")!.id;
const scene = s.dispatch("scene.create", { name: "Chrome Title", template: "chromeTitle", durationFrames: 60, text: "DEMO" });
s.transaction("Demo edit", "user", (tx) => {
  tx.dispatch("clip.add", { trackId: mus, clip: { type: "media", assetId: music.id, start: 0, duration: 300 } });
  tx.dispatch("clip.add", { trackId: v1, clip: { type: "scene", sceneId: scene.sceneId, start: 0, duration: 60 } });
  const c1 = tx.dispatch("clip.add", { trackId: v1, clip: { type: "media", assetId: a!.id, start: 60, duration: 90 } });
  const c2 = tx.dispatch("clip.add", { trackId: v1, clip: { type: "media", assetId: b!.id, start: 150, duration: 120 } });
  tx.dispatch("clip.setTransition", { clipId: c1.clipId, transition: { type: "flash", duration: 8 } });
  tx.dispatch("clip.setTransition", { clipId: c2.clipId, transition: { type: "crossfade", duration: 15 } });
  tx.dispatch("effect.add", { clipId: c2.clipId, type: "splitTone", params: { shadowAmount: 0.4, highlightAmount: 0.3 } });
  tx.dispatch("clip.add", { trackId: titles, clip: { type: "text", text: "NIGHT CITY", start: 70, duration: 60, style: { fontSize: 120 }, animation: { in: "pop", out: "slideUp" } } });
});
await engine.analyzeBeats(music.id);
await s.save({ backup: true });
console.log(s.dir);
await engine.closeProject();
