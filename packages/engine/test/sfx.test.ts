import { describe, expect, it } from "vitest";
import { encodeWav, SFX_KINDS, sfxPlacement, synthesizeSfx } from "../src/media/sfx.js";

const rms = (a: Float32Array, i0: number, i1: number) => {
  let s = 0;
  for (let i = i0; i < i1; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / Math.max(1, i1 - i0));
};

describe("procedural sound effects", () => {
  it("renders every kind at the requested length, normalised and deterministic", () => {
    for (const kind of SFX_KINDS) {
      const a = synthesizeSfx(kind, { seed: 3 });
      const b = synthesizeSfx(kind, { seed: 3 });
      expect(a.left.length).toBeGreaterThan(1000);
      expect(Array.from(a.left.slice(0, 2000))).toEqual(Array.from(b.left.slice(0, 2000)));
      let peak = 0;
      for (let i = 0; i < a.left.length; i++) peak = Math.max(peak, Math.abs(a.left[i]!), Math.abs(a.right[i]!));
      expect(peak, kind).toBeCloseTo(0.891, 2);
      expect(a.left.every(Number.isFinite), kind).toBe(true);
    }
    expect(synthesizeSfx("riser", { duration: 3 }).left.length).toBe(3 * 48000);
  });

  it("shapes risers, impacts and whooshes where they are anchored", () => {
    const r = synthesizeSfx("riser", { duration: 2 }).left;
    const sr = 48000;
    // A riser gets louder towards its end.
    expect(rms(r, 1.6 * sr, 1.95 * sr)).toBeGreaterThan(4 * rms(r, 0.1 * sr, 0.5 * sr));
    // An impact is loudest at its start.
    const im = synthesizeSfx("impact").left;
    expect(rms(im, 0, 0.3 * sr)).toBeGreaterThan(3 * rms(im, 2 * sr, 2.4 * sr));
    // A whoosh peaks around 62 % of its length.
    const w = synthesizeSfx("whoosh").left;
    const n = w.length;
    expect(rms(w, 0.55 * n, 0.68 * n)).toBeGreaterThan(rms(w, 0.05 * n, 0.2 * n) * 2);
  });

  it("places risers to end on the anchor, whooshes to peak on it and hits to start on it", () => {
    expect(sfxPlacement("riser", 120, 30, 2)).toEqual({ start: 60, frames: 60 });
    expect(sfxPlacement("whoosh", 100, 30)).toEqual({ start: 85, frames: 24 });
    expect(sfxPlacement("impact", 90, 30)).toEqual({ start: 90, frames: 75 });
    expect(sfxPlacement("riser", 10, 30, 2).start).toBe(0); // clamped at the timeline start
  });

  it("writes a valid 48 kHz stereo WAV header", () => {
    const { left, right } = synthesizeSfx("blip");
    const wav = encodeWav(left, right);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(48000);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.length).toBe(44 + left.length * 4);
  });
});
