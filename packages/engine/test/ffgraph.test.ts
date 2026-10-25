import { describe, expect, it } from "vitest";
import { applyCommand, buildCompositionPlan, createProject, EASINGS, evalCurve } from "@mantagli/core";
import { buildGraph, curveExpr } from "../src/render/ffgraph.js";

/** Evaluate an FFmpeg expression of one variable in JS (the subset the graph builder emits). */
function ffExpr(expr: string, v: string): (x: number) => number {
  const body = expr.replace(/\bif\(/g, "iff(");
  return new Function(
    v,
    `const lt=(a,b)=>a<b?1:0, gt=(a,b)=>a>b?1:0, iff=(c,a,b)=>c?a:b, pow=Math.pow, clip=(x,a,b)=>Math.min(b,Math.max(a,x)), abs=Math.abs; return ${body};`,
  ) as (x: number) => number;
}

function graphFor(text: string) {
  let p = createProject({ name: "G", format: "square" });
  const titles = p.tracks.find((t) => t.kind === "text")!.id;
  p = applyCommand(p, "clip.add", { trackId: titles, clip: { type: "text", text, start: 0, duration: 60, animation: { in: "pop", out: "fade", duration: 12 } } }).project;
  const files: Record<string, string> = {};
  const g = buildGraph({
    project: p,
    plan: buildCompositionPlan(p),
    scale: 0.5,
    mediaPath: (a) => a.path,
    sceneFrames: () => undefined,
    fontFile: () => "C:/Windows/Fonts/arialbd.ttf",
    writeFile: (n, c) => (files[n] = typeof c === "string" ? c : "<binary>"),
    includeAudio: true,
    output: "video",
  });
  return { g, files };
}

describe("FFmpeg graph builder", () => {
  it("draws one drawtext per line (newlines render as tofu otherwise)", () => {
    const { g, files } = graphFor("CUT TO\nTHE BEAT");
    expect(g.filter.match(/drawtext=/g)).toHaveLength(2);
    expect(Object.values(files)).toContain("CUT TO");
    expect(Object.values(files)).toContain("THE BEAT");
    expect(Object.values(files).some((c) => c.includes("\n") && !c.includes("colorchannelmixer"))).toBe(false);
  });

  it("applies opacity before any per-frame scale (filters after it crop resized frames)", () => {
    const { g } = graphFor("POP");
    const chain = g.filter.split(";\n").find((l) => l.includes("eval=frame") && l.includes("scale="))!;
    expect(chain).toBeDefined();
    expect(chain.indexOf("colorchannelmixer")).toBeGreaterThan(-1);
    expect(chain.indexOf("colorchannelmixer")).toBeLessThan(chain.indexOf("scale="));
  });

  it("escapes Windows paths for filter options", async () => {
    const { filterPath } = await import("../src/render/ffgraph.js");
    expect(filterPath("C:\\Windows\\Fonts\\a.ttf")).toBe("'C\\:/Windows/Fonts/a.ttf'");
    expect(() => filterPath("C:\\it's.ttf")).toThrow();
  });

  it("matches core easing curves for every easing (export = live preview)", () => {
    for (const easing of EASINGS) {
      if (easing === "hold") continue;
      const curve = [{ frame: 0, value: -20, easing }, { frame: 24, value: 80, easing: "linear" as const }];
      const f = ffExpr(curveExpr(curve, "t", 24), "t");
      for (const fr of [0, 1, 5, 11.5, 12, 18, 23, 24, 30]) expect(f(fr / 24), `${easing} @${fr}`).toBeCloseTo(evalCurve(curve, fr), 3);
    }
  });

  it("builds piecewise eased expressions", () => {
    const e = curveExpr([{ frame: 0, value: 0, easing: "linear" }, { frame: 30, value: 10, easing: "linear" }], "t", 30);
    // At t=0.5 the linear segment yields 5.
    const f = new Function("t", `const lt=(a,b)=>a<b?1:0; const iff=(c,a,b)=>c?a:b; return ${e.replace(/if\(/g, "iff(")};`);
    expect(f(0.5)).toBeCloseTo(5);
    expect(f(2)).toBe(10);
  });
});
