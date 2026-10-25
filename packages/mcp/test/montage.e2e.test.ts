import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeFixtures, TMP } from "../../engine/test/fixtures.js";

/**
 * Agent-style acceptance test: an MCP client (standing in for Claude Code)
 * builds a beat-synced montage with a Blender 3D title purely through the
 * Mantagli tools, previews it, exports it and checks the verified result.
 * Real FFmpeg and Blender; no mocks.
 */
const repo = path.resolve(import.meta.dirname, "../../..");
const home = path.join(TMP, "home-mcp-montage");
const projects = path.join(TMP, "mcp-projects");
let client: Client;

type Content = { type: string; text?: string; data?: string };
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
  const data = JSON.parse(r.content[0]!.text!);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(data)}`);
  return { data, images: r.content.filter((c) => c.type === "image") };
}

beforeAll(async () => {
  await rm(projects, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  // The fixtures are an allowed AI media folder, wherever the checkout lives.
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ projectsDir: projects, aiMediaFolders: [path.join(TMP, "media")] }));
  await makeFixtures();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "packages/mcp/src/main.ts")],
    env: { ...(process.env as Record<string, string>), MANTAGLI_HOME: home },
    stderr: "pipe",
  });
  client = new Client({ name: "montage-agent", version: "1.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
});

describe("agent montage over MCP", () => {
  it("builds, previews and exports a beat-synced montage with a 3D title", async () => {
    await call("project_create", { name: "Agent Montage", format: "vertical", fps: "30" });
    await call("project_update_settings", { width: 540, height: 960 });

    const media = path.join(TMP, "media");
    const imp = await call("media_import", { paths: ["clip_a.mp4", "clip_b.mp4", "music_120bpm.wav", "still.png"].map((f) => path.join(media, f)) });
    expect(imp.data.imported).toHaveLength(4);
    const id = (name: string) => imp.data.imported.find((a: { name: string }) => a.name === name).id as string;

    let state = (await call("project_get_state")).data;
    const track = (n: string) => state.tracks.find((t: { name: string }) => t.name === n).id as string;
    const music = state.tracks.find((t: { role: string }) => t.role === "music").id as string;

    await call("timeline_add_clip", { trackId: music, type: "media", assetId: id("music_120bpm.wav"), start: 0, duration: 240 });
    const beats = (await call("audio_analyze", { assetId: id("music_120bpm.wav") })).data;
    expect(Math.abs(beats.bpm - 120)).toBeLessThan(3);
    const bf: number[] = beats.beatFrames;
    expect(bf.length).toBeGreaterThan(10);

    // 3D title for the intro, then cuts that land on beats.
    const scene = (await call("scene_create", { name: "Intro Title", template: "chromeTitle", durationFrames: 45, text: "AGENT", accentA: "#9b30ff", accentB: "#00e5ff" })).data;
    await call("scene_set_render_settings", { sceneId: scene.sceneId, render: { samples: 8, motionBlur: false } });
    const cut1 = bf.find((f) => f >= 45)!;
    const cut2 = bf.find((f) => f >= cut1 + 45)!;
    const cut3 = bf.find((f) => f >= cut2 + 30)!;
    await call("timeline_add_clip", { trackId: track("V1"), type: "scene", sceneId: scene.sceneId, start: 0, duration: cut1 });
    const seq = await call("timeline_place_sequence", {
      trackId: track("V1"),
      shots: [
        { assetId: id("clip_a.mp4"), start: cut1, duration: cut2 - cut1, transitionIn: { type: "flash", duration: 6 }, look: "cyberpunk" },
        { assetId: id("clip_b.mp4"), start: cut2, duration: cut3 - cut2, speed: 1.5, transitionIn: { type: "slideLeft", duration: 8 }, look: "cyberpunk" },
        { assetId: id("clip_a.mp4"), start: cut3, duration: 240 - cut3, sourceIn: 2, transitionIn: { type: "crossfade", duration: 10 }, keyframes: [{ property: "scale", frame: 0, value: 1 }, { property: "scale", frame: 240 - cut3, value: 1.3 }] },
      ],
    });
    expect(seq.data.clips.map((c: { start: number }) => c.start)).toEqual([cut1, cut2, cut3]);
    await call("timeline_add_clip", { trackId: track("Titles"), type: "text", text: "CUT TO\nTHE BEAT", start: cut1, duration: 50, style: { fontSize: 72, strokeWidth: 3 }, animation: { in: "pop", out: "fade" } });
    await call("plan_save", { brief: "Beat-synced test montage", summary: "3D intro, three beat cuts, cyberpunk look", status: "done", shots: [{ index: 0, description: "3D title", startFrame: 0, durationFrames: cut1 }] });

    state = (await call("project_get_state")).data;
    expect(state.issues.filter((i: { severity: string }) => i.severity === "error")).toEqual([]);

    // Visual review: real rendered frames come back as images.
    const preview = await call("preview_render", { frames: [20, cut1 + 10, cut3 + 5] });
    expect(preview.images).toHaveLength(3);
    expect(preview.images[0]!.data!.length).toBeGreaterThan(1000);

    const check = (await call("project_validate_render", { preset: "reel1080" })).data;
    expect(check.ok, JSON.stringify(check.issues)).toBe(true);
    // A waited export answers within the MCP timeout; long ones are polled like an agent would.
    const t0 = Date.now();
    let exp = (await call("export_render", { preset: "reel1080", wait: true })).data;
    expect(Date.now() - t0).toBeLessThan(55_000);
    while (exp.status !== "done") {
      expect(["queued", "running"]).toContain(exp.status);
      const j = (await call("export_status", { jobId: exp.jobId, waitSeconds: 40 })).data;
      exp = j.status === "done" ? { status: "done", ...j.result } : { ...j, jobId: exp.jobId };
    }
    expect(exp.check.ok).toBe(true);
    expect(exp.check.width).toBe(1080);
    expect(exp.check.height).toBe(1920);
    expect(exp.check.duration).toBeCloseTo(8, 1);

    // Undo works through MCP too.
    const undo = await call("project_undo");
    expect(undo.data.undone).toBeTruthy();
  });
});
