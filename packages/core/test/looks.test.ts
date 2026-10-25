import { describe, expect, it } from "vitest";
import { lookSpec, scaleLookToFrame, LOOKS } from "../src/index.js";

const fx = (look: ReturnType<typeof lookSpec>, type: string) => look!.effects.find((e) => e.type === type)!.params;

describe("built-in looks follow the frame size", () => {
  it("keeps 1080-short-side frames as authored and scales pixel params elsewhere", () => {
    const crt = LOOKS.find((l) => l.id === "crtMonitor")!;
    expect(lookSpec("crtMonitor", [], { width: 1080, height: 1920 })).toBe(crt);
    // 540×960 (the CPU benchmark): a 2 px fringe and 4 px scanline pitch were twice as strong as authored.
    const half = lookSpec("crtMonitor", [], { width: 540, height: 960 });
    expect(fx(half, "chromaticAberration").pixels).toBe(1);
    expect(fx(half, "scanlines").spacing).toBe(2);
    expect(fx(half, "scanlines").amount).toBe(0.18); // not a pixel param
    expect(fx(half, "lensDistortion").amount).toBe(0.22);
    const uhd = lookSpec("crtMonitor", [], { width: 3840, height: 2160 });
    expect(fx(uhd, "chromaticAberration").pixels).toBe(4);
    expect(fx(uhd, "scanlines").spacing).toBe(8);
  });

  it("scales pixel params left at their defaults, clamps to range and leaves saved looks alone", () => {
    const glow = { id: "g", label: "G", description: "", effects: [{ type: "glow", params: { strength: 0.5 } }] };
    expect(scaleLookToFrame(glow, { width: 2160, height: 3840 }).effects[0]!.params.radius).toBe(36); // default 18 px
    const big = { id: "b", label: "B", description: "", effects: [{ type: "scanlines", params: { spacing: 2 } }] };
    expect(scaleLookToFrame(big, { width: 360, height: 640 }).effects[0]!.params.spacing).toBe(2); // min 2
    const saved = { id: "mine", label: "Mine", description: "", effects: [{ type: "chromaticAberration", params: { pixels: 6 } }] };
    expect(fx(lookSpec("mine", [saved], { width: 540, height: 960 }), "chromaticAberration").pixels).toBe(6);
  });
});
