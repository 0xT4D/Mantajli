import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeFixtures, TMP } from "./fixtures.js";

process.env.MANTAGLI_HOME = path.join(TMP, "home-ramp");
const { Engine } = await import("../src/engine.js");
const { run } = await import("../src/util/proc.js");
const { sourceOffset } = await import("@mantagli/core");

const engine = new Engine();
afterAll(async () => {
  await engine.closeProject();
});

/** PSNR (dB) between two images of the same size. */
async function psnr(a: string, b: string): Promise<number> {
  const r = await run("ffmpeg", ["-hide_banner", "-v", "info", "-i", a, "-i", b, "-filter_complex", "[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]psnr", "-f", "null", "-"], { timeoutMs: 30000 });
  const m = /average:([\d.]+|inf)/.exec(r.stderr)?.[1];
  return m === "inf" ? 99 : Number(m);
}

describe("speed ramps", () => {
  it("renders each frame from the source time the core ramp predicts", async () => {
    await engine.init();
    const media = await makeFixtures();
    const dir = path.join(TMP, "ramp");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await engine.createProject({ name: "Ramp", format: "landscape", parentDir: dir });
    const r = await engine.importMedia([media.video]);
    const s = engine.requireSession();
    const v1 = s.project.tracks.find((t) => t.name === "V1")!.id;
    // clip_a: testsrc2 1280x720 @ 30 fps, 6 s (content changes every frame).
    const c = s.dispatch("clip.add", { trackId: v1, clip: { type: "media", assetId: r.imported[0]!.id, start: 0, duration: 60, sourceIn: 0.5 } });
    s.dispatch("clip.update", { clipId: c.clipId, props: { transform: { fit: "stretch" } } });
    s.dispatch("clip.setSpeedRamp", { clipId: c.clipId, ramp: [{ frame: 0, value: 0.5, easing: "linear" }, { frame: 40, value: 3, easing: "easeIn" }] });
    const clip = s.project.tracks.find((t) => t.id === v1)!.clips[0]!;

    for (const f of [7, 25, 33, 50]) {
      const still = (await engine.renderStill(f, { scale: 1 })).path;
      const t = clip.type === "media" ? clip.sourceIn + sourceOffset(clip, 0, f, 30) : 0;
      const ref = path.join(dir, `ref_${f}.png`);
      const wrong = path.join(dir, `wrong_${f}.png`);
      // Reference: the source frame shown at time t (frame-accurate seek), scaled like the clip.
      const frameAt = (sec: number, out: string) =>
        run("ffmpeg", ["-v", "error", "-y", "-i", media.video, "-vf", `select='eq(n\\,${Math.floor(sec * 30 + 1e-6)})',scale=1920:1080`, "-frames:v", "1", out], { timeoutMs: 30000 });
      await frameAt(t, ref);
      // A constant-speed clip would show this frame instead.
      await frameAt(clip.type === "media" ? clip.sourceIn + f / 30 : 0, wrong);
      const good = await psnr(still, ref);
      expect(good, `frame ${f} (source ${t.toFixed(3)} s)`).toBeGreaterThan(30);
      if (f > 10) expect(await psnr(still, wrong)).toBeLessThan(good - 3);
    }
  });
});
