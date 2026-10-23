import { describe, expect, it } from "vitest";
import { evalLayer, layerCurves, makeColorClip, makeTextClip, normalizeEffectParams, revealLines, textReveal, transitionMask, type Clip } from "../src/index.js";

const fx = (type: string, params: Record<string, unknown> = {}) => ({ id: `fx_${type}`, type, enabled: true, params: normalizeEffectParams(type, params) });
const opts = { width: 1920, height: 1080, hasOutgoing: false, fps: 30 };

describe("motion effects", () => {
  it("shake is deterministic, bounded and moves the layer", () => {
    const clip: Clip = { ...makeColorClip({ fill: "#ffffff", start: 0, duration: 60 }), effects: [fx("shake", { amount: 2, rotation: 3, seed: 7 })] };
    const a = layerCurves(clip, opts);
    const b = layerCurves(clip, opts);
    const xs = Array.from({ length: 60 }, (_, f) => evalLayer(a, f));
    expect(xs.map((s) => s.x)).toEqual(Array.from({ length: 60 }, (_, f) => evalLayer(b, f).x));
    expect(Math.max(...xs.map((s) => Math.abs(s.x)))).toBeLessThanOrEqual(0.02 * 1920 + 1e-6);
    expect(Math.max(...xs.map((s) => Math.abs(s.rotation)))).toBeLessThanOrEqual(3 + 1e-6);
    expect(new Set(xs.map((s) => Math.round(s.x))).size).toBeGreaterThan(5);
    // A different seed gives a different path.
    const other = layerCurves({ ...clip, effects: [fx("shake", { amount: 2, seed: 8 })] }, opts);
    expect(evalLayer(other, 10).x).not.toBeCloseTo(xs[10]!.x, 3);
  });

  it("beat pulse punches in on beat markers inside the clip and decays", () => {
    const clip: Clip = { ...makeColorClip({ fill: "#ffffff", start: 100, duration: 60 }), effects: [fx("beatPulse", { zoom: 0.2, decay: 6, on: "beats" })] };
    const markers = [
      { frame: 90, kind: "beat" }, // before the clip
      { frame: 110, kind: "beat" },
      { frame: 120, kind: "cue" }, // not a beat
      { frame: 130, kind: "downbeat" },
      { frame: 133, kind: "beat" }, // interrupts the decay of the previous one
    ];
    const c = layerCurves(clip, { ...opts, markers });
    const s = (f: number) => evalLayer(c, f).scale;
    expect(s(5)).toBe(1);
    expect(s(10)).toBeCloseTo(1.2);
    expect(s(13)).toBeGreaterThan(1);
    expect(s(13)).toBeLessThan(1.2);
    expect(s(16)).toBeCloseTo(1);
    expect(s(20)).toBe(1);
    expect(s(30)).toBeCloseTo(1.2);
    expect(s(33)).toBeCloseTo(1.2);
    expect(s(45)).toBeCloseTo(1);
    // Downbeats only.
    const d = layerCurves({ ...clip, effects: [fx("beatPulse", { zoom: 0.2, on: "downbeats" })] }, { ...opts, markers });
    expect(evalLayer(d, 10).scale).toBe(1);
    expect(evalLayer(d, 30).scale).toBeCloseTo(1.2);
  });
});

describe("typewriter and wipe masks", () => {
  it("reveals characters across lines and types out at the end", () => {
    const t = makeTextClip({ text: "AB\nCDE", start: 0, duration: 20, animation: { in: "typewriter", out: "typewriter", duration: 5 } });
    expect([0, 1, 2, 3, 4, 10].map((f) => textReveal(t, f))).toEqual([1, 2, 3, 4, 5, 5]);
    expect([15, 17, 19].map((f) => textReveal(t, f))).toEqual([4, 2, 0]);
    expect(revealLines(t.text, 3)).toEqual(["AB", "C"]);
    // Typewriter does not fade the layer.
    expect(evalLayer(layerCurves(t, opts), 0).opacity).toBe(1);
  });

  it("produces eased progress during wipe transitions only", () => {
    const c: Clip = { ...makeColorClip({ fill: "#ffffff", start: 0, duration: 30 }), transitionIn: { type: "wipeLeft", duration: 10 } };
    expect(transitionMask(c, 0)).toEqual({ shape: "left", progress: 0 });
    expect(transitionMask(c, 5)!.progress).toBeCloseTo(0.5);
    expect(transitionMask(c, 10)).toBeNull();
    expect(transitionMask({ ...c, transitionIn: { type: "crossfade", duration: 10 } }, 5)).toBeNull();
  });
});

describe("music ducking", () => {
  it("builds a dB envelope with attack/release and joins close triggers", async () => {
    const { duckCurve, evalCurve } = await import("../src/index.js");
    const d = { enabled: true, amountDb: 12, attackFrames: 5, releaseFrames: 10, triggers: ["dialogue" as const] };
    const c = duckCurve([[30, 60], [65, 90], [200, 220]], d, 10);
    // Clip-relative frames (clip starts at 10). 60→65 is shorter than attack+release: stays ducked.
    expect(evalCurve(c, 0)).toBe(0);
    expect(evalCurve(c, 15)).toBe(0);
    expect(evalCurve(c, 17.5)).toBeCloseTo(-6);
    expect(evalCurve(c, 20)).toBe(-12);
    expect(evalCurve(c, 52)).toBe(-12);
    expect(evalCurve(c, 85)).toBeCloseTo(-6);
    expect(evalCurve(c, 120)).toBe(0);
    expect(evalCurve(c, 192)).toBe(-12);
    expect(duckCurve([], d, 0)).toEqual([]);
  });
});

describe("shape masks", () => {
  it("is 1 inside, 0.5 on the edge, 0 outside, and flips when inverted", async () => {
    const { maskAlpha, maskGeometry } = await import("../src/index.js");
    const rect = maskGeometry({ shape: "rectangle", x: 0, y: 0, width: 0.5, height: 0.5, feather: 0.1, invert: false }, 200, 100);
    expect(maskAlpha(rect, 100, 50)).toBe(1);
    expect(maskAlpha(rect, 150, 50)).toBeCloseTo(0.5); // right edge at x = 100 + 50
    expect(maskAlpha(rect, 199, 50)).toBe(0);
    const ell = maskGeometry({ shape: "ellipse", x: 0.25, y: 0, width: 0.2, height: 0.4, feather: 0, invert: true }, 200, 100);
    expect(maskAlpha(ell, 150, 50)).toBe(0); // centre of the inverted ellipse
    expect(maskAlpha(ell, 10, 10)).toBe(1);
  });
});

describe("word-by-word captions", () => {
  it("reveals whole words, across lines, and removes them at the end", () => {
    const t = makeTextClip({ text: "WAIT FOR\nTHE DROP", start: 0, duration: 40, animation: { in: "words", out: "words", duration: 8 } });
    // 4 words over 8 frames: one more word every 2 frames.
    expect([0, 1, 2, 3, 5, 7, 20].map((f) => revealLines(t.text, textReveal(t, f)))).toEqual([
      ["", ""],
      ["WAIT", ""],
      ["WAIT", ""],
      ["WAIT FOR", ""],
      ["WAIT FOR", "THE"],
      ["WAIT FOR", "THE DROP"],
      ["WAIT FOR", "THE DROP"],
    ]);
    expect(revealLines(t.text, textReveal(t, 39))).toEqual(["", ""]);
    expect(evalLayer(layerCurves(t, opts), 0).opacity).toBe(1);
  });
});
