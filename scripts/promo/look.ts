// Promo look development: create the promo's 3D scenes and render one test frame of each.
// Usage: npx tsx scripts/promo/look.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = "D:/MantagliPromo";
process.env.MANTAGLI_HOME = path.join(ROOT, "home");
const { Engine, executeTool } = await import("../../packages/engine/src/index.ts");

const engine = new Engine();
await engine.init();
await mkdir(path.join(ROOT, "media"), { recursive: true });
const gem = path.join(ROOT, "media", "gem.obj");
// A faceted brilliant-cut style gem: crown ring, girdle, pavilion point.
{
  // OBJ is Y-up (Blender's importer converts to Z-up).
  const v: string[] = ["v 0 1.1 0"];
  const f: string[] = [];
  const n = 12;
  for (let i = 0; i < n; i++) v.push(`v ${0.55 * Math.cos((2 * Math.PI * i) / n)} 0.95 ${-0.55 * Math.sin((2 * Math.PI * i) / n)}`);
  for (let i = 0; i < n; i++) v.push(`v ${Math.cos((2 * Math.PI * (i + 0.5)) / n)} 0.55 ${-Math.sin((2 * Math.PI * (i + 0.5)) / n)}`);
  v.push("v 0 -0.9 0");
  const top = 1, crown = (i: number) => 2 + (i % n), girdle = (i: number) => 2 + n + (i % n), tip = 2 + 2 * n;
  for (let i = 0; i < n; i++) {
    f.push(`f ${top} ${crown(i)} ${crown(i + 1)}`);
    f.push(`f ${crown(i)} ${girdle(i)} ${crown(i + 1)}`);
    f.push(`f ${crown(i + 1)} ${girdle(i)} ${girdle(i + 1)}`);
    f.push(`f ${girdle(i)} ${tip} ${girdle(i + 1)}`);
  }
  await writeFile(gem, [...v, ...f].join("\n") + "\n");
}

const dir = path.join(ROOT, "Mantagli Promo.mantagli");
try {
  await engine.openProject(dir, { force: true });
} catch {
  await engine.createProject({ name: "Mantagli Promo", format: "landscape", parentDir: ROOT });
}
const s = engine.requireSession();
const tool = async (name: string, input: Record<string, unknown>) => {
  const r = await executeTool({ engine, source: "user" }, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.data as any;
};
const gemAsset = s.project.assets.find((a) => a.name === "gem.obj") ?? (await engine.importMedia([gem])).imported[0]!;

const want = [
  { name: "Particles", template: "particleBackdrop", durationFrames: 120, accentA: "#7c3aed", accentB: "#22d3ee" },
  { name: "Logo", template: "chromeTitle", durationFrames: 120, text: "MANTAGLI", accentA: "#8b5cf6", accentB: "#22d3ee", particles: true },
  { name: "Neon", template: "neonFlythrough", durationFrames: 90, accentA: "#ff2bd6", accentB: "#22d3ee" },
  { name: "Gem", template: "productTurntable", durationFrames: 90, modelAssetId: gemAsset.id, material: "gold", accentA: "#f59e0b", accentB: "#8b5cf6" },
  { name: "EndLogo", template: "chromeTitle", durationFrames: 120, text: "MANTAGLI", accentA: "#f5b041", accentB: "#8b5cf6", material: "gold", particles: true },
];
const ids: Record<string, string> = {};
for (const w of want) {
  const existing = s.project.scenes.find((x) => x.name === w.name);
  ids[w.name] = existing?.id ?? (await tool("scene_create", w)).sceneId;
  await tool("scene_set_render_settings", { sceneId: ids[w.name], preset: "eeveeHigh", ...(w.name === "Gem" ? { world: { color: "#040406", strength: 0.3, reflections: 1.4 } } : {}) });
  if (w.name === "Gem") {
    // Float the gem in darkness: no floor (it would mirror the bright studio band).
    const floor = s.project.scenes.find((x) => x.id === ids[w.name])!.objects.find((o) => o.name === "Floor");
    if (floor) s.dispatch("scene.removeObject", { sceneId: ids[w.name]!, objectId: floor.id });
  }
}
const out: string[] = [];
for (const [name, frame] of [["Particles", 60], ["Logo", 100], ["Neon", 45], ["Gem", 30], ["EndLogo", 100]] as const) {
  const r = await engine.renderScene(ids[name]!, { quality: "final", scale: 0.5, frames: [frame] });
  out.push(path.join(r.dir, `frame_${String(frame).padStart(5, "0")}.png`));
}
await writeFile(path.join(ROOT, "look.txt"), out.join("\n"));
console.log(out.join("\n"));
await engine.closeProject();
process.exit(0);
