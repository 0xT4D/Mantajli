import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine, EngineServer, ProjectSession } from "@mantagli/engine";

const repo = path.resolve(import.meta.dirname, "../../..");
const tsxCli = path.join(repo, "node_modules", "tsx", "dist", "cli.mjs");
const mcpMain = path.join(repo, "packages", "mcp", "src", "main.ts");

let tmp: string;
let projectDir: string;

async function connect(home: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, mcpMain],
    env: { ...(process.env as Record<string, string>), MANTAGLI_HOME: home },
    stderr: "pipe",
  });
  const client = new Client({ name: "mantagli-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const text = (r: { content: unknown }) => JSON.parse((r.content as { type: string; text: string }[])[0]!.text);

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "mantagli-mcp-"));
  const s = await ProjectSession.create(tmp, { name: "MCP Project" });
  projectDir = s.dir;
  await s.close();
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("MCP server", () => {
  it("standalone: lists tools, opens a project and edits it", async () => {
    const client = await connect(path.join(tmp, "home-standalone"));
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const n of ["project_get_state", "timeline_add_clip", "scene_create", "preview_render", "export_render", "audio_analyze"]) expect(names).toContain(n);

      const noProject = await client.callTool({ name: "project_get_state", arguments: {} });
      expect(noProject.isError).toBe(true);

      const opened = await client.callTool({ name: "project_open", arguments: { path: projectDir } });
      expect(opened.isError, JSON.stringify(opened.content)).toBeFalsy();
      const added = await client.callTool({ name: "timeline_add_track", arguments: { kind: "video", name: "FromMCP" } });
      expect(added.isError).toBeFalsy();
      const state = text(await client.callTool({ name: "project_get_state", arguments: {} }));
      expect(state.tracks.some((t: { name: string }) => t.name === "FromMCP")).toBe(true);

      const invalid = await client.callTool({ name: "timeline_move_clip", arguments: { clipId: "nope", start: 2 } });
      expect(invalid.isError).toBe(true);
      expect(text(invalid).error.category).toBe("not_found");
      await client.callTool({ name: "project_save", arguments: {} });
    } finally {
      await client.close();
    }
  });

  it("bridge: forwards tool calls to the running app engine", async () => {
    const home = path.join(tmp, "home-bridge");
    process.env.MANTAGLI_HOME = home;
    const engine = new Engine();
    await engine.init();
    const server = new EngineServer(engine);
    await server.listen(0);
    await engine.openProject(projectDir, { force: true });
    const client = await connect(home);
    try {
      const r = await client.callTool({ name: "timeline_add_track", arguments: { kind: "text", name: "Bridged" } });
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
      // The edit landed in the app's in-memory session, with MCP as the source.
      expect(engine.project.tracks.some((t) => t.name === "Bridged")).toBe(true);
      expect(engine.requireSession().history.list().undo[0]!.source).toBe("mcp");
    } finally {
      await client.close();
      await server.close();
      delete process.env.MANTAGLI_HOME;
    }
  });
});
