import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssetSchema } from "@mantagli/core";
import { Director, type ModelClient } from "../src/ai/director.js";
import { executeTool, TOOLS, toolJsonSchema, type ToolContext } from "../src/ai/tools.js";
import { Engine } from "../src/engine.js";

let dir: string;
let engine: Engine;

function addFakeAsset(id: string, kind: "video" | "audio", duration: number) {
  engine.requireSession().dispatch("asset.add", {
    asset: AssetSchema.parse({
      id,
      kind,
      name: `${id}.${kind === "video" ? "mp4" : "wav"}`,
      path: path.join(dir, `${id}.bin`),
      size: 1,
      hash: id,
      importedAt: new Date().toISOString(),
      meta: { duration, width: kind === "video" ? 1920 : undefined, height: kind === "video" ? 1080 : undefined, hasVideo: kind === "video", hasAudio: true },
    }),
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mantagli-ai-"));
  process.env.MANTAGLI_HOME = path.join(dir, "home");
  engine = new Engine();
  await engine.config.load();
  await engine.createProject({ name: "AI Test", parentDir: dir });
  addFakeAsset("ast_vid1", "video", 10);
  addFakeAsset("ast_vid2", "video", 6);
});

afterEach(async () => {
  await engine.closeProject();
  await rm(dir, { recursive: true, force: true });
});

const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ engine, source: "ai", ...extra });
const v1 = () => engine.project.tracks.find((t) => t.name === "V1")!.id;

describe("AI tools", () => {
  it("exposes valid JSON schemas for every tool", () => {
    for (const t of TOOLS) {
      const s = toolJsonSchema(t);
      expect(s.type, t.name).toBe("object");
    }
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  });

  it("validates input and reports categorized errors", async () => {
    const bad = await executeTool(ctx(), "timeline_move_clip", { clipId: "x", start: -5 });
    expect(bad.ok).toBe(false);
    expect(bad.error!.category).toBe("invalid_params");
    const missing = await executeTool(ctx(), "timeline_move_clip", { clipId: "clip_nope", start: 5 });
    expect(missing.error!.category).toBe("not_found");
    const unknown = await executeTool(ctx(), "rm_rf", {});
    expect(unknown.error!.category).toBe("unsupported");
  });

  it("places a beat-cut sequence atomically and undoes it in one step", async () => {
    const r = await executeTool(ctx(), "timeline_place_sequence", {
      trackId: v1(),
      shots: [
        { assetId: "ast_vid1", start: 0, duration: 15, transitionIn: { type: "crossfade", duration: 6 } },
        { assetId: "ast_vid2", start: 15, duration: 15, look: "cyberpunk", transitionIn: { type: "flash", duration: 4 } },
        { assetId: "ast_vid1", start: 30, duration: 30, sourceIn: 4, keyframes: [{ property: "scale", frame: 0, value: 1 }, { property: "scale", frame: 30, value: 1.2 }] },
      ],
    });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    const clips = engine.project.tracks.find((t) => t.id === v1())!.clips;
    expect(clips.map((c) => [c.start, c.duration])).toEqual([[0, 15], [15, 15], [30, 30]]);
    expect(clips[1]!.effects.length).toBeGreaterThan(2);
    engine.requireSession().undo();
    expect(engine.project.tracks.find((t) => t.id === v1())!.clips).toHaveLength(0);
  });

  it("edit_batch is all-or-nothing", async () => {
    const before = engine.project;
    const r = await executeTool(ctx(), "edit_batch", {
      commands: [
        { command: "track.add", params: { kind: "video" } },
        { command: "clip.move", params: { clipId: "clip_missing", start: 3 } },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.error!.message).toMatch(/Command #1/);
    expect(engine.project).toBe(before);
    const forbidden = await executeTool(ctx(), "edit_batch", { commands: [{ command: "asset.add", params: {} }] });
    expect(forbidden.error!.category).toBe("unsupported");
  });

  it("refuses imports outside allowed folders", async () => {
    const r = await executeTool(ctx(), "media_import", { paths: ["C:\\Windows\\System32\\drivers\\etc\\hosts"] });
    expect(r.error!.category).toBe("permission_denied");
  });

  it("asks for approval before large deletions and respects a decline", async () => {
    await executeTool(ctx(), "timeline_place_sequence", { trackId: v1(), shots: Array.from({ length: 6 }, (_, i) => ({ assetId: "ast_vid1", start: i * 10, duration: 10 })) });
    const ids = engine.project.tracks.find((t) => t.id === v1())!.clips.map((c) => c.id);
    let asked = "";
    const r = await executeTool(ctx({ approve: async (q) => ((asked = q.summary), false) }), "timeline_remove_clip", { clipIds: ids });
    expect(asked).toMatch(/6 clips/);
    expect(r.error!.category).toBe("permission_denied");
    expect(engine.project.tracks.find((t) => t.id === v1())!.clips).toHaveLength(6);
  });

  it("creates 3D scenes and applies looks", async () => {
    const s = await executeTool(ctx(), "scene_create", { name: "Title", template: "chromeTitle", durationFrames: 60, text: "HELLO" });
    expect(s.ok).toBe(true);
    const sceneId = (s.data as { sceneId: string }).sceneId;
    const cam = await executeTool(ctx(), "scene_add_camera", { sceneId, location: [0, -8, 2], focalLength: 85 });
    expect(cam.ok).toBe(true);
    expect(engine.project.scenes[0]!.activeCameraId).toBe((cam.data as { objectId: string }).objectId);
    const anim = await executeTool(ctx(), "scene_animate", { sceneId, objectId: (cam.data as { objectId: string }).objectId, property: "focalLength", keyframes: [{ frame: 0, value: [85] }, { frame: 59, value: [35] }] });
    expect(anim.ok).toBe(true);
  });
});

// ---------------------------------------------------------------- director

function scripted(steps: ((req: Anthropic.Beta.BetaMessageParam[]) => Partial<Anthropic.Beta.BetaMessage>)[]): ModelClient {
  let i = 0;
  return {
    async send(p) {
      const step = steps[Math.min(i++, steps.length - 1)]!;
      const m = step(p.messages);
      for (const b of m.content ?? []) if (b.type === "text") p.onText(b.text);
      return {
        id: `msg_${i}`,
        type: "message",
        role: "assistant",
        model: p.model,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [],
        ...m,
      } as unknown as Anthropic.Beta.BetaMessage;
    },
  };
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });

async function waitDone(director: Director, runId: string) {
  for (let i = 0; i < 200; i++) {
    const r = director.get(runId)!;
    if (r.status !== "running" && r.status !== "awaiting_approval") return r;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("run did not finish");
}

describe("AI director", () => {
  it("runs a tool loop, records changes and can revert them", async () => {
    const seenResults: unknown[] = [];
    const director = new Director(engine, () =>
      scripted([
        () => ({ stop_reason: "tool_use", content: [toolUse("t1", "project_get_state", {}), toolUse("t2", "timeline_add_clip", { trackId: v1(), type: "media", assetId: "ast_vid1", start: 0, duration: 30 })] as never }),
        (msgs) => {
          seenResults.push(msgs[msgs.length - 1]);
          return { stop_reason: "end_turn", content: [{ type: "text", text: "Placed one shot.", citations: null }] as never };
        },
      ]),
    );
    const run = director.start("Put the first clip on V1", { autonomy: "autonomous" });
    const done = await waitDone(director, run.id);
    expect(done.status).toBe("done");
    expect(done.changed).toBe(true);
    expect(done.events.some((e) => e.type === "tool_result" && e.name === "timeline_add_clip" && e.ok)).toBe(true);
    expect(JSON.stringify(seenResults[0])).toContain("tool_result");
    expect(engine.project.tracks.find((t) => t.id === v1())!.clips).toHaveLength(1);

    director.revert(run.id);
    expect(engine.project.tracks.find((t) => t.id === v1())!.clips).toHaveLength(0);
    // Revert itself is undoable.
    engine.requireSession().undo();
    expect(engine.project.tracks.find((t) => t.id === v1())!.clips).toHaveLength(1);
  });

  it("feeds tool errors back to the model and stops after repeated failures", async () => {
    const director = new Director(engine, () => scripted([() => ({ stop_reason: "tool_use", content: [toolUse(`t${Math.random()}`, "timeline_move_clip", { clipId: "clip_nope", start: 1 })] as never })]));
    const run = director.start("break things", { autonomy: "autonomous" });
    const done = await waitDone(director, run.id);
    expect(done.status).toBe("failed");
    expect(done.events.filter((e) => e.type === "tool_result" && !e.ok).length).toBeGreaterThanOrEqual(6);
  });

  it("pauses for approval in review mode and can be cancelled", async () => {
    await executeTool(ctx(), "timeline_place_sequence", { trackId: v1(), shots: Array.from({ length: 6 }, (_, i) => ({ assetId: "ast_vid1", start: i * 10, duration: 10 })) });
    const ids = engine.project.tracks.find((t) => t.id === v1())!.clips.map((c) => c.id);
    const director = new Director(engine, () => scripted([() => ({ stop_reason: "tool_use", content: [toolUse("t1", "timeline_remove_clip", { clipIds: ids })] as never })]));
    const run = director.start("delete everything", { autonomy: "review" });
    for (let i = 0; i < 100 && director.get(run.id)!.status !== "awaiting_approval"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(director.get(run.id)!.status).toBe("awaiting_approval");
    director.cancel(run.id);
    const done = await waitDone(director, run.id);
    expect(done.status).toBe("cancelled");
    expect(engine.project.tracks.find((t) => t.id === v1())!.clips).toHaveLength(6);
  });
});
