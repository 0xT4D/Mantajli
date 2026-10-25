import { describe, expect, it } from "vitest";
import { evalLayer, layerCurves, makeColorClip, makeTextClip, normalizeEffectParams, revealLines, SCRAMBLE_GLYPHS, textLinesAt, textReveal, transitionMask, type Clip } from "../src/index.js";

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

describe("two-sided transitions", () => {
  it("moves both shots of a whip pan together and blurs them with their speed", async () => {
    const { buildCompositionPlan, createProject, applyCommand, transitionFx } = await import("../src/index.js");
    let p = createProject({ name: "W", format: "landscape" });
    const v1 = p.tracks.find((t) => t.name === "V1")!.id;
    p = applyCommand(p, "clip.add", { trackId: v1, clip: { type: "color", fill: "#ff0000", start: 0, duration: 30 } }).project;
    const b = applyCommand(p, "clip.add", { trackId: v1, clip: { type: "color", fill: "#0000ff", start: 30, duration: 30 } });
    p = applyCommand(b.project, "clip.setTransition", { clipId: b.result.clipId, transition: { type: "whipLeft", duration: 10 } }).project;
    const plan = buildCompositionPlan(p);
    const [outL, inL] = plan.layers;
    expect(outL!.transitionOut?.type).toBe("whipLeft");
    expect(outL!.tail).toBe(10);
    const o = { width: 1920, height: 1080, hasOutgoing: true, fps: 30 };
    const oc = layerCurves(outL!.clip, { ...o, transitionOut: outL!.transitionOut });
    const ic = layerCurves(inL!.clip, o);
    let peak = 0;
    for (let j = 0; j <= 10; j++) {
      const xo = evalLayer(oc, 30 + j).x;
      const xi = evalLayer(ic, j).x;
      expect(xi - xo).toBeCloseTo(1920, 6); // butted edge to edge the whole time
      if (j < 10) peak = Math.max(peak, transitionFx(inL!.clip, j, o).blurRadius);
    }
    expect(evalLayer(oc, 29).x).toBe(0); // untouched before the transition
    expect(peak).toBeGreaterThan(150); // fast in the middle
    expect(transitionFx(inL!.clip, 0, o).blurRadius).toBeLessThan(peak / 10); // nearly still at the ends
    expect(transitionFx(outL!.clip, 35, { ...o, transitionOut: outL!.transitionOut }).blurRadius).toBeCloseTo(transitionFx(inL!.clip, 5, o).blurRadius, 6);
  });

  it("honours transition easing and intensity overrides", async () => {
    const { transitionFx, ZOOM_THROUGH_SCALE } = await import("../src/index.js");
    const o = { width: 1920, height: 1080, hasOutgoing: true, fps: 30 };
    const clip = (t: object): Clip => ({ ...makeColorClip({ fill: "#0000ff", start: 30, duration: 30 }), transitionIn: { type: "whipLeft", duration: 10, ...t } });
    // Linear whip: constant speed, so the same blur in every interior frame.
    const lin = [3, 5, 7].map((f) => transitionFx(clip({ easing: "linear" }), f, o).blurRadius);
    expect(lin[0]).toBeCloseTo(lin[2]!, 6);
    expect(evalLayer(layerCurves(clip({ easing: "linear" }), o), 5).x).toBeCloseTo(1920 / 2, 6);
    // Intensity scales the blur; 0 switches it off.
    expect(transitionFx(clip({ intensity: 2 }), 5, o).blurRadius).toBeCloseTo(2 * transitionFx(clip({}), 5, o).blurRadius, 6);
    expect(transitionFx(clip({ intensity: 0 }), 5, o).blurRadius).toBe(0);
    // Zoom-through peak grows with intensity.
    const z = clip({});
    z.transitionIn = { type: "zoomThrough", duration: 10, intensity: 2 };
    expect(evalLayer(layerCurves(z, o), 5).scale).toBeCloseTo(1 + 2 * (ZOOM_THROUGH_SCALE - 1), 6);
  });

  it("crops moving shots to their frame cell unless the clip moves itself", async () => {
    const { cropsToFrameCell } = await import("../src/index.js");
    const base = makeColorClip({ fill: "#ff0000", start: 0, duration: 30 });
    const whip = { type: "whipLeft", duration: 10 };
    expect(cropsToFrameCell({ ...base, transitionIn: whip })).toBe(true);
    expect(cropsToFrameCell(base, whip)).toBe(true); // outgoing side
    expect(cropsToFrameCell({ ...base, transitionIn: { type: "crossfade", duration: 10 } })).toBe(false);
    expect(cropsToFrameCell({ ...base, transitionIn: whip, keyframes: { x: [{ frame: 0, value: 0, easing: "linear" }, { frame: 30, value: 200, easing: "linear" }] } })).toBe(false); // a pan keeps its overflow
    expect(cropsToFrameCell({ ...base, transitionIn: whip, transform: { ...base.transform, x: 40 } })).toBe(false);
    expect(cropsToFrameCell({ ...base, transitionIn: whip, effects: [{ id: "fx1", type: "shake", enabled: true, params: {} }] })).toBe(false);
  });

  it("zooms through with a continuous scale at the cut and glitch-cuts with RGB split", async () => {
    const { transitionFx, transitionTail, ZOOM_THROUGH_SCALE } = await import("../src/index.js");
    const t = { type: "zoomThrough", duration: 10 };
    expect(transitionTail(t)).toBe(5);
    const outClip = makeColorClip({ fill: "#ff0000", start: 0, duration: 30 });
    const inClip: Clip = { ...makeColorClip({ fill: "#0000ff", start: 30, duration: 30 }), transitionIn: t };
    const o = { width: 1920, height: 1080, hasOutgoing: true, fps: 30 };
    const oc = layerCurves(outClip, { ...o, transitionOut: t });
    const ic = layerCurves(inClip, o);
    expect(evalLayer(oc, 34).scale).toBeCloseTo(ZOOM_THROUGH_SCALE); // outgoing peaks on its last frame
    expect(evalLayer(ic, 5).scale).toBeCloseTo(ZOOM_THROUGH_SCALE); // incoming starts from the peak
    expect(evalLayer(ic, 4).opacity).toBe(0);
    expect(evalLayer(ic, 5).opacity).toBe(1);
    expect(evalLayer(ic, 10).scale).toBe(1);
    expect(transitionFx(inClip, 6, o).zoomSigma).toBeGreaterThan(transitionFx(inClip, 9, o).zoomSigma);
    const g: Clip = { ...inClip, transitionIn: { type: "glitchCut", duration: 10 } };
    const shifts = Array.from({ length: 10 }, (_, f) => transitionFx(g, f, o).rgbShift);
    expect(shifts.some((v) => v !== 0)).toBe(true);
    expect(transitionFx(g, 12, o).rgbShift).toBe(0);
  });
});

describe("scramble (decode) text", () => {
  it("decodes left to right from random glyphs, deterministically, and encodes out", () => {
    const t = makeTextClip({ text: "CYBER\nCAMP", start: 0, duration: 60, animation: { in: "scramble", out: "scramble", duration: 12 } });
    const at = (f: number) => textLinesAt(t, f);
    // Fully decoded at the end of the in-animation and in the middle.
    expect(at(11)).toEqual(["CYBER", "CAMP"]);
    expect(at(30)).toEqual(["CYBER", "CAMP"]);
    // First frame: only the first characters have appeared, as glyphs.
    const first = at(0).join("");
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(9);
    expect([...first].every((c) => SCRAMBLE_GLYPHS.includes(c) || "CYBERCAMP".includes(c))).toBe(true);
    // Mid-way: a decoded prefix followed by glyphs; same output every call.
    const mid = at(7);
    expect(mid).toEqual(at(7));
    expect(mid[0]!.startsWith("C")).toBe(true);
    expect(mid.join("")).not.toEqual("CYBERCAMP");
    // Glyphs hold for 2 frames (the appearing front still advances every frame).
    const a2 = at(2)[0]!;
    const a3 = at(3)[0]!;
    expect(a3.startsWith(a2)).toBe(true);
    // Out: last frame shows nothing; the layer never fades.
    expect(at(59).join("")).toBe("");
    expect(evalLayer(layerCurves(t, opts), 0).opacity).toBe(1);
    // Whitespace is preserved while scrambling.
    const spaced = makeTextClip({ text: "THE BEST", start: 0, duration: 40, animation: { in: "scramble", out: "fade", duration: 10 } });
    expect(textLinesAt(spaced, 6)[0]![3]).toBe(" ");
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
