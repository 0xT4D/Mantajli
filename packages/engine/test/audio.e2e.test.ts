import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TMP } from "./fixtures.js";

process.env.MANTAGLI_HOME = path.join(TMP, "home-audio");
const { Engine } = await import("../src/engine.js");
const { run } = await import("../src/util/proc.js");

const engine = new Engine();
afterAll(async () => {
  await engine.closeProject();
});

async function ff(args: string[]): Promise<string> {
  const r = await run("ffmpeg", ["-hide_banner", "-nostats", "-y", ...args], { timeoutMs: 60000 });
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stderr;
}

/** RMS level (dB) of the 440 Hz band in [from, from+dur) seconds of a file. */
async function rms440(file: string, from: number, dur: number): Promise<number> {
  const log = await ff(["-ss", String(from), "-t", String(dur), "-i", file, "-af", "bandpass=f=440:width_type=q:w=8,astats=measure_perchannel=none", "-f", "null", "-"]);
  return Number(/RMS level dB:\s*(-?[\d.]+)/.exec(log.split("Overall").pop()!)?.[1]);
}

describe("audio mix", () => {
  it("ducks music under dialogue and normalises export loudness", async () => {
    await engine.init();
    const dir = path.join(TMP, "audiomix");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const music = path.join(dir, "music440.wav");
    const voice = path.join(dir, "voice880.wav");
    await ff(["-f", "lavfi", "-i", "sine=f=440:d=4", "-af", "volume=-12dB", "-ac", "2", music]);
    await ff(["-f", "lavfi", "-i", "sine=f=880:d=1", "-af", "volume=-12dB", "-ac", "2", voice]);

    await engine.createProject({ name: "Mix", format: "landscape", parentDir: dir });
    const r = await engine.importMedia([music, voice]);
    const s = engine.requireSession();
    const musicTrack = s.project.tracks.find((t) => t.role === "music")!.id;
    const sfx = s.project.tracks.find((t) => t.role === "sfx")!.id;
    s.dispatch("track.update", { trackId: sfx, role: "dialogue", name: "Voice" });
    s.dispatch("clip.add", { trackId: musicTrack, clip: { type: "media", assetId: r.imported.find((a) => a.name === "music440.wav")!.id, start: 0, duration: 120 } });
    s.dispatch("clip.add", { trackId: sfx, clip: { type: "media", assetId: r.imported.find((a) => a.name === "voice880.wav")!.id, start: 45, duration: 30 } });
    s.dispatch("clip.add", { trackId: s.project.tracks.find((t) => t.name === "V1")!.id, clip: { type: "color", fill: "#202020", start: 0, duration: 120 } });
    s.dispatch("project.setMix", { ducking: { enabled: true, amountDb: 12, attackFrames: 3, releaseFrames: 3 } });
    s.dispatch("project.setExport", { preset: "landscape1080", crf: 30, encoderPreset: "ultrafast" });

    const out1 = path.join(dir, "ducked.mp4");
    await engine.startExport({ outPath: out1 }).promise;
    const open = await rms440(out1, 0.3, 0.8); // before the voice (1.5 s – 2.5 s)
    const ducked = await rms440(out1, 1.7, 0.6);
    const after = await rms440(out1, 3.0, 0.7);
    expect(open - ducked).toBeGreaterThan(10.5);
    expect(open - ducked).toBeLessThan(13.5);
    expect(Math.abs(open - after)).toBeLessThan(1);

    // Loudness target: integrated loudness lands on -14 LUFS.
    s.dispatch("project.setExport", { loudnessLufs: -14 });
    const out2 = path.join(dir, "loud.mp4");
    await engine.startExport({ outPath: out2 }).promise;
    const log = await ff(["-i", out2, "-af", "ebur128", "-f", "null", "-"]);
    const integrated = Number(/I:\s*(-?[\d.]+) LUFS/.exec(log.split("Summary:").pop()!)?.[1]);
    expect(Math.abs(integrated - -14)).toBeLessThan(1.5);
  });
});
