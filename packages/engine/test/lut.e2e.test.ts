import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeFixtures, TMP } from "./fixtures.js";

process.env.MANTAGLI_HOME = path.join(TMP, "home-lut");
const { Engine } = await import("../src/engine.js");
const { run } = await import("../src/util/proc.js");

/** 2x2x2 .cube LUT that inverts colours. */
function invertCube(): string {
  const rows: string[] = ["TITLE \"invert\"", "LUT_3D_SIZE 2"];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) rows.push(`${1 - r} ${1 - g} ${1 - b}`);
  return rows.join("\n") + "\n";
}

const engine = new Engine();
afterAll(async () => {
  await engine.closeProject();
});

/** PSNR (dB) between image a and image b, optionally negating b first. */
async function psnr(a: string, b: string, negateB: boolean): Promise<number> {
  const graph = `[1:v]${negateB ? "negate," : ""}format=rgb24[b];[0:v]format=rgb24[a];[a][b]psnr`;
  const r = await run("ffmpeg", ["-hide_banner", "-v", "info", "-i", a, "-i", b, "-filter_complex", graph, "-f", "null", "-"], { timeoutMs: 30000 });
  const m = /average:([\d.]+|inf)/.exec(r.stderr)?.[1];
  return m === "inf" ? 99 : Number(m);
}

describe("LUT effect", () => {
  it("applies an imported .cube LUT in the exact render", async () => {
    await engine.init();
    const media = await makeFixtures();
    const dir = path.join(TMP, "lut");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const cube = path.join(dir, "invert.cube");
    await writeFile(cube, invertCube());
    await engine.createProject({ name: "LUT", format: "landscape", parentDir: dir });
    const r = await engine.importMedia([media.image, cube]);
    const img = r.imported.find((a) => a.kind === "image")!;
    const lut = r.imported.find((a) => a.kind === "lut")!;
    expect(lut).toBeDefined();
    const s = engine.requireSession();
    const v1 = s.project.tracks.find((t) => t.name === "V1")!.id;
    const c = s.dispatch("clip.add", { trackId: v1, clip: { type: "media", assetId: img.id, start: 0, duration: 30 } });
    s.dispatch("clip.update", { clipId: c.clipId, props: { transform: { fit: "stretch" } } });
    const before = (await engine.renderStill(5, { scale: 0.25 })).path;
    s.dispatch("effect.add", { clipId: c.clipId, type: "lut", params: { assetId: lut.id } });
    const after = (await engine.renderStill(5, { scale: 0.25 })).path;
    // The LUT render must match a negated original closely, and differ from the original.
    expect(await psnr(after, before, true)).toBeGreaterThan(30);
    expect(await psnr(after, before, false)).toBeLessThan(15);
  });
});
