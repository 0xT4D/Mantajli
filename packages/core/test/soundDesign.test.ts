import { describe, expect, it } from "vitest";
import { applyCommand, AssetSchema, createProject, sfxPlacement, suggestSoundDesign, type CommandName, type CommandParams, type Project } from "../src/index.js";

function run<N extends CommandName>(p: Project, name: N, params: CommandParams<N>) {
  const r = applyCommand(p, name, params);
  return { project: r.project, result: r.result as never as Record<string, string> };
}
const track = (p: Project, name: string) => p.tracks.find((t) => t.name === name)!.id;
const audioAsset = (id: string, tags: string[] = []) =>
  AssetSchema.parse({ id, kind: "audio", name: `${id}.wav`, path: `/m/${id}.wav`, size: 1, hash: id, importedAt: new Date().toISOString(), meta: { duration: 60, hasAudio: true, hasVideo: false }, tags });

/** 30 fps landscape project: shots every 60 frames with the given transitions, music, sections, titles. */
function build(opts: { generatedMusic?: boolean } = {}) {
  let p = createProject({ name: "SD", format: "landscape" });
  const v1 = track(p, "V1");
  const transitions = [null, { type: "whipLeft", duration: 10 }, { type: "zoomThrough", duration: 12 }, { type: "glitchCut", duration: 8 }, { type: "crossfade", duration: 12 }] as const;
  const shots: string[] = [];
  transitions.forEach((tr, i) => {
    const r = run(p, "clip.add", { trackId: v1, clip: { type: "color", fill: "#202020", start: i * 60, duration: 60, name: `shot ${i}` } });
    p = r.project;
    shots.push(r.result.clipId!);
    if (tr) p = run(p, "clip.setTransition", { clipId: r.result.clipId!, transition: tr }).project;
  });
  p = run(p, "asset.add", { asset: audioAsset("music", opts.generatedMusic ? ["generated", "music"] : []) }).project;
  const music = p.tracks.find((t) => t.role === "music")!.id;
  p = run(p, "clip.add", { trackId: music, clip: { type: "media", assetId: "music", start: 0, duration: 600 } }).project;
  p = run(p, "marker.setBeats", {
    beats: Array.from({ length: 40 }, (_, k) => ({ frame: k * 15, downbeat: k % 4 === 0 })),
    sections: [{ frame: 0, label: "intro" }, { frame: 90, label: "drop" }, { frame: 240, label: "breakdown" }],
  }).project;
  const titles = track(p, "Titles");
  const text = (t: string, start: number, anim: "scramble" | "typewriter" | "pop" | "fade") =>
    (p = run(p, "clip.add", { trackId: titles, clip: { type: "text", text: t, start, duration: 30, animation: { in: anim, out: "none" } } }).project);
  text("DECODE", 30, "scramble");
  text("typing", 150, "typewriter");
  text("SLAM", 300, "pop"); // on a downbeat (300 = 20 × 15)
  text("plain", 330, "fade");
  return { p, shots };
}

describe("sound design suggestions", () => {
  it("caps density: a crowded stretch keeps transitions and drops, dropping title accents first", () => {
    const { p } = build();
    // Squeeze the timeline: only 10 s of clips → at most ceil(10 × 0.6) + 2 = 8 effects.
    const short = { ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.start + c.duration <= 300) })) };
    const s = suggestSoundDesign(short);
    expect(s.length).toBeLessThanOrEqual(8);
    expect(s.filter((x) => x.trigger === "transition")).toHaveLength(4);
    expect(s.filter((x) => x.trigger === "title").length).toBeLessThan(2);
  });

  it("answers transitions, drops, breakdowns and titles with the right effect at the right frame", () => {
    const { p, shots } = build();
    const s = suggestSoundDesign(p);
    const at = (kind: string, ref: string) => s.find((x) => x.kind === kind && x.ref === ref);
    expect(at("whoosh", shots[1]!)?.anchorFrame).toBe(60 + 5); // whip peaks mid-transition
    expect(at("riser", shots[2]!)?.anchorFrame).toBe(120 + 6); // zoom through: riser into the cut...
    expect(at("hit", shots[2]!)?.anchorFrame).toBe(126); // ...and a hit on it
    expect(at("glitch", shots[3]!)).toBeDefined();
    expect(s.some((x) => x.ref === shots[4])).toBe(false); // a dissolve needs no effect
    const drop = s.filter((x) => x.trigger === "section" && x.anchorFrame === 90).map((x) => x.kind).sort();
    expect(drop).toEqual(["impact", "riser"]);
    expect(s.find((x) => x.kind === "downlifter")?.anchorFrame).toBe(240);
    expect(s.find((x) => x.reason.includes("DECODE"))?.kind).toBe("glitch");
    expect(s.find((x) => x.reason.includes("typing"))?.kind).toBe("blip");
    expect(s.find((x) => x.reason.includes("SLAM"))?.kind).toBe("hit");
    expect(s.some((x) => x.reason.includes("plain"))).toBe(false); // no accent off the beat
    // Placement matches the anchor semantics.
    const riser = at("riser", shots[2]!)!;
    const pl = sfxPlacement("riser", riser.anchorFrame, 30, riser.duration);
    expect(pl.start + pl.frames).toBe(riser.anchorFrame);
    // Sorted by time, one per moment (riser + hit share the zoom-through cut by design).
    for (let k = 1; k < s.length; k++) expect(s[k]!.anchorFrame).toBeGreaterThanOrEqual(s[k - 1]!.anchorFrame);
  });

  it("leaves drops to generated music, skips frames that already have an effect, and stays quiet under dialogue", () => {
    const { p: base, shots } = build({ generatedMusic: true });
    let p = base;
    expect(suggestSoundDesign(p).some((x) => x.trigger === "section")).toBe(false);
    // An existing whoosh at the whip peak: no second one.
    p = run(p, "asset.add", { asset: audioAsset("w") }).project;
    const sfx = run(p, "track.add", { kind: "audio", name: "SFX", role: "sfx" });
    p = run(sfx.project, "clip.add", { trackId: sfx.result.trackId!, clip: { type: "media", assetId: "w", start: 65 - 15, duration: 24, name: "whoosh" } }).project;
    expect(suggestSoundDesign(p).some((x) => x.ref === shots[1])).toBe(false);
    // Voice over the zoom-through and the SLAM title: transition effects 6 dB down, title accent dropped.
    p = run(p, "asset.add", { asset: audioAsset("vo") }).project;
    const dlg = run(p, "track.add", { kind: "audio", name: "Voice", role: "dialogue" });
    p = run(dlg.project, "clip.add", { trackId: dlg.result.trackId!, clip: { type: "media", assetId: "vo", start: 110, duration: 30 } }).project;
    p = run(p, "clip.add", { trackId: dlg.result.trackId!, clip: { type: "media", assetId: "vo", start: 290, duration: 30 } }).project;
    const s = suggestSoundDesign(p);
    expect(s.find((x) => x.kind === "hit" && x.ref === shots[2])?.gainDb).toBe(-12);
    expect(s.some((x) => x.reason.includes("SLAM"))).toBe(false);
    // Intensity shifts every level.
    const subtle = suggestSoundDesign(p, { intensity: "subtle" });
    expect(subtle.find((x) => x.ref === shots[3])!.gainDb).toBe(s.find((x) => x.ref === shots[3])!.gainDb - 4);
  });
});
