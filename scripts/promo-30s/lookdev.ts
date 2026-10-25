/**
 * Look development for the 30 s promo: one final-quality frame per candidate 3D scene at the
 * project size, timed, through the engine's real Blender path.
 *   npx tsx scripts/promo-30s/lookdev.ts [template ...]
 */
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../tests/.tmp/promo-30s/lookdev");
process.env.MANTAGLI_HOME = path.join(ROOT, "home");
const { Engine, executeTool } = await import("../../packages/engine/src/index.ts");
const engine = new Engine();
await engine.init();
await engine.config.update({ autoRenderScenes: false });
const tool = async (name: string, input: Record<string, unknown>) => {
  const r = await executeTool({ engine, source: "user" }, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.data as any;
};
await rm(path.join(ROOT, "Lookdev.mantagli"), { recursive: true, force: true });
await mkdir(ROOT, { recursive: true });
await engine.createProject({ name: "Lookdev", format: "vertical", parentDir: ROOT });
const s = engine.requireSession();
const want = process.argv.slice(2);
const cases: [string, Record<string, unknown>, number][] = [
  ["chromeTitle", { text: "MANTAGLI", accentA: "#7d6bff", accentB: "#38e1ff" }, 60],
  ["neonFlythrough", { accentA: "#7d6bff", accentB: "#38e1ff" }, 60],
  ["synthwaveHorizon", {}, 60],
  ["metalTitle", { text: "MANTAGLI" }, 60],
  ["stageReveal", {}, 60],
  ["particleBackdrop", { accentA: "#7d6bff" }, 60],
];
for (const [template, extra, frame] of cases) {
  if (want.length && !want.includes(template)) continue;
  const sc = await tool("scene_create", { name: template, template, durationFrames: 120, ...extra });
  await tool("scene_set_render_settings", { sceneId: sc.sceneId, preset: "eeveeFast" });
  const t = Date.now();
  const r = await engine.renderScene(sc.sceneId, { quality: "final", scale: 1, frames: [frame] });
  const secs = (Date.now() - t) / 1000;
  await copyFile(path.join(r.dir, `frame_${String(frame).padStart(5, "0")}.png`), path.join(ROOT, `${template}.png`));
  console.log(template, `${secs.toFixed(1)} s/frame`, r.warnings.join("; "));
}
void s;
await engine.closeProject();
process.exit(0);
