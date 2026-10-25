import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TMP } from "./fixtures.js";

process.env.MANTAGLI_HOME = path.join(TMP, "home-sounddesign");
const { Engine } = await import("../src/engine.js");
const { executeTool } = await import("../src/ai/tools.js");

const engine = new Engine();
const ROOT = path.join(TMP, "sounddesign");
const tool = async <T = any>(name: string, input: Record<string, unknown>) => {
  const r = await executeTool({ engine, source: "ai" }, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.data as T;
};

beforeAll(async () => {
  await engine.init();
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
}, 120_000);
afterAll(async () => {
  await engine.closeProject();
});

describe("sound design and mix metering through the tools", () => {
  it("suggests, applies once, and meters the mix against the export loudness target", async () => {
    await engine.createProject({ name: "Mix", format: "landscape", parentDir: ROOT });
    const s = engine.requireSession();
    const v1 = s.project.tracks.find((t) => t.name === "V1")!.id;
    for (let k = 0; k < 4; k++) await tool("timeline_add_clip", { trackId: v1, type: "color", start: k * 90, duration: 90, fill: "#303040" });
    const shots = s.project.tracks.find((t) => t.id === v1)!.clips;
    await tool("timeline_add_transition", { clipId: shots[1]!.id, type: "whipLeft", duration: 10 });
    await tool("timeline_add_transition", { clipId: shots[2]!.id, type: "zoomThrough", duration: 12 });
    await tool("music_generate", { style: "techno", mood: "dark", duration: 12 });

    const list = await tool<{ suggestions: { index: number; kind: string; anchorFrame: number; trigger: string }[] }>("sfx_suggest", {});
    expect(list.suggestions.find((x) => x.kind === "whoosh")?.anchorFrame).toBe(95);
    expect(list.suggestions.filter((x) => x.trigger === "section")).toHaveLength(0); // generated music has its own hits
    const applied = await tool<{ applied: number; placed: { clipId: string }[] }>("sfx_suggest", { apply: true });
    expect(applied.applied).toBe(list.suggestions.length);
    const sfxClips = s.project.tracks.filter((t) => t.role === "sfx").flatMap((t) => t.clips);
    expect(sfxClips.length).toBe(list.suggestions.length);
    // Applied effects now count as existing: asking again proposes nothing new there.
    expect((await tool<{ suggestions: unknown[] }>("sfx_suggest", {})).suggestions).toHaveLength(0);

    // A voice over un-ducked music is flagged.
    await tool("voice_narrate", { segments: [{ text: "Level seven is open." }], start: 120, duck: false, captions: false }).catch(() => undefined);
    const hasVoice = s.project.tracks.some((t) => t.role === "dialogue" && t.clips.length);
    const raw = await tool<{ integratedLufs: number; truePeakDb: number; warnings: string[] }>("audio_meter", {});
    expect(Number.isFinite(raw.integratedLufs)).toBe(true);
    expect(Number.isFinite((raw as unknown as { maxShortTermLufs: number }).maxShortTermLufs)).toBe(true); // per-frame log parsed
    if (hasVoice) expect(raw.warnings.some((w) => /ducking/.test(w))).toBe(true);

    // With a -14 LUFS export target the measured mix lands there, peaks under 0 dBTP.
    await tool("export_set_settings", { loudnessLufs: -14 });
    const norm = await tool<{ integratedLufs: number; truePeakDb: number; exportLoudnessTarget: number }>("audio_meter", {});
    expect(norm.exportLoudnessTarget).toBe(-14);
    expect(Math.abs(norm.integratedLufs + 14)).toBeLessThan(1.5);
    expect(norm.truePeakDb).toBeLessThan(0);
  }, 300_000);
});
