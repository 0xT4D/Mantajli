import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AssetSchema } from "@mantagli/core";
import { analyzeAudio, toBeatAnalysis } from "../src/media/derive.js";
import { generateMusic, MUSIC_STYLES, planMusicSections } from "../src/media/music.js";
import { encodeWav } from "../src/media/sfx.js";
import { TMP } from "./fixtures.js";

const rms = (a: Float32Array, t0: number, t1: number) => {
  let s = 0;
  const [i0, i1] = [Math.floor(t0 * 48000), Math.floor(t1 * 48000)];
  for (let i = i0; i < i1; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / Math.max(1, i1 - i0));
};

describe("music generator", () => {
  it("plans whole structures: every bar used, drops on 4-bar phrases", () => {
    for (const n of [4, 9, 14, 20, 32, 60, 120]) {
      const plan = planMusicSections(n);
      expect(plan.reduce((s, x) => s + x.bars, 0), `bars ${n}`).toBe(n);
      expect(plan[0]!.kind).toBe("intro");
      expect(plan.some((x) => x.kind === "drop")).toBe(true);
      for (const d of plan.filter((x) => x.kind === "drop" && x.bars >= 4)) expect(d.bars % 4).toBe(0);
      expect(plan.every((x) => x.bars >= 1)).toBe(true);
    }
    expect(planMusicSections(60).filter((x) => x.kind === "drop")).toHaveLength(2);
  });

  it("renders exactly the requested length, deterministically, with louder drops than intros", () => {
    for (const style of MUSIC_STYLES) {
      const a = generateMusic({ style, mood: "dark", duration: 20, seed: 4 });
      expect(a.left.length, style).toBe(20 * 48000);
      expect(a.beats[1]! - a.beats[0]!).toBeCloseTo(60 / a.bpm, 6);
      let peak = 0;
      for (let i = 0; i < a.left.length; i++) peak = Math.max(peak, Math.abs(a.left[i]!), Math.abs(a.right[i]!));
      expect(peak, style).toBeLessThanOrEqual(0.891);
      expect(a.left.every(Number.isFinite), style).toBe(true);
      const intro = a.sections.find((x) => x.label === "intro")!;
      const drop = a.sections.find((x) => x.label === "drop")!;
      const bar = 240 / a.bpm;
      expect(rms(a.left, drop.time, drop.time + 2 * bar), style).toBeGreaterThan(1.8 * rms(a.left, intro.time, intro.time + intro.bars * bar));
    }
    const x = generateMusic({ style: "synthwave", mood: "tense", duration: 8, seed: 2 });
    const y = generateMusic({ style: "synthwave", mood: "tense", duration: 8, seed: 2 });
    const z = generateMusic({ style: "synthwave", mood: "tense", duration: 8, seed: 3 });
    expect(Array.from(x.left.slice(96000, 98000))).toEqual(Array.from(y.left.slice(96000, 98000)));
    expect(Array.from(x.left.slice(96000, 98000))).not.toEqual(Array.from(z.left.slice(96000, 98000)));
  });

  it("follows an explicit structure, trimmed or extended to the duration", () => {
    const r = generateMusic({ style: "techno", mood: "uplifting", duration: 30, bpm: 120, sections: [{ kind: "intro", bars: 4 }, { kind: "drop", bars: 8 }, { kind: "outro", bars: 100 }] });
    expect(r.sections.map((s) => [s.label, s.bars])).toEqual([["intro", 4], ["drop", 8], ["outro", 3]]);
    expect(r.sections[1]!.time).toBeCloseTo(8, 6); // 4 bars at 120 BPM
  });

  it("is heard by the app's own beat tracker at the tempo it was written in", async () => {
    const dir = path.join(TMP, "music");
    await mkdir(dir, { recursive: true });
    for (const [style, bpm] of [["synthwave", 118], ["techno", 128]] as const) {
      const r = generateMusic({ style, mood: "dark", duration: 24, bpm, seed: 7 });
      const file = path.join(dir, `${style}.wav`);
      await writeFile(file, encodeWav(r.left, r.right));
      const asset = AssetSchema.parse({ id: `ast_${style}`, kind: "audio", name: `${style}.wav`, path: file, size: 1, hash: "x", importedAt: new Date().toISOString(), meta: { duration: 24, hasAudio: true, hasVideo: false } });
      const detected = toBeatAnalysis((await analyzeAudio("ffmpeg", asset, { beats: true })).beats!);
      expect(Math.abs(detected.bpm - bpm) / bpm, `${style}: detected ${detected.bpm}`).toBeLessThan(0.03);
      // The written drop is found as a section boundary by the detector, within half a second.
      const drop = r.sections.find((s) => s.label === "drop")!.time;
      expect(detected.sections.some((s) => Math.abs(s.time - drop) < 0.6), `${style}: drop ${drop.toFixed(2)} vs ${JSON.stringify(detected.sections)}`).toBe(true);
    }
  }, 120_000);
});
