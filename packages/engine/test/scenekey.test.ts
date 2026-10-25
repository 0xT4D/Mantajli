import { describe, expect, it } from "vitest";
import { applyCommand, createProject, type Project } from "@mantagli/core";
import { canonicalIds, sceneRenderKey } from "../src/render/blender.js";

function withScene(p: Project, name: string, text: string): { p: Project; id: string } {
  const r = applyCommand(p, "scene.create", { name, template: "chromeTitle", durationFrames: 60, text });
  return { p: r.project, id: (r.result as { sceneId: string }).sceneId };
}
const key = (p: Project, id: string) => sceneRenderKey({ project: p, scene: p.scenes.find((s) => s.id === id)!, quality: "final", resolutionScale: 1, defaultFont: "/f.ttf" });

describe("3D frame cache keys", () => {
  it("match for identical scenes whatever their ids, and change with the content", () => {
    let p = createProject({ name: "K", format: "vertical" });
    const a = withScene(p, "A", "ARENA 7");
    const b = withScene(a.p, "B (rebuilt)", "ARENA 7");
    p = b.p;
    expect(p.scenes[0]!.id).not.toBe(p.scenes[1]!.id);
    expect(p.scenes[0]!.objects[0]!.id).not.toBe(p.scenes[1]!.objects[0]!.id);
    expect(key(p, a.id)).toBe(key(p, b.id)); // same picture → same frames (the name is not part of it)
    const c = withScene(p, "C", "ARENA 8");
    expect(key(c.p, c.id)).not.toBe(key(c.p, a.id));
    // A camera aimed at a different object is a different scene even though only an id differs.
    expect(canonicalIds('{"a":"obj_aaaaaaaaaa","b":"obj_bbbbbbbbbb","look":"obj_aaaaaaaaaa"}')).not.toBe(canonicalIds('{"a":"obj_aaaaaaaaaa","b":"obj_bbbbbbbbbb","look":"obj_bbbbbbbbbb"}'));
    expect(canonicalIds('{"a":"obj_aaaaaaaaaa","look":"obj_aaaaaaaaaa"}')).toBe(canonicalIds('{"a":"obj_zzzzzzzzzz","look":"obj_zzzzzzzzzz"}'));
  });
});
