/**
 * Mantagli MCP server (stdio).
 *
 * If the Mantagli app is running, tool calls are forwarded to its engine so
 * Claude Code edits the same live project the user sees (shared undo
 * history). Otherwise an engine runs in this process and works on project
 * folders directly (use project_open / project_create first).
 *
 * Register with Claude Code:
 *   claude mcp add mantagli -- npx tsx <repo>/packages/mcp/src/main.ts
 */
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket from "ws";
import { Engine, ENGINE_INFO_FILE, executeTool, TOOLS, type ToolResult } from "@mantagli/engine";

// stdout is the MCP channel: route stray logs to stderr.
console.log = (...a: unknown[]) => console.error(...a);
process.removeAllListeners("warning");

type CallFn = (name: string, input: unknown) => Promise<ToolResult>;

async function connectToApp(): Promise<{ call: CallFn; close(): void } | undefined> {
  let info: { port: number; token: string; pid: number };
  try {
    info = JSON.parse(await readFile(ENGINE_INFO_FILE(), "utf8"));
    process.kill(info.pid, 0);
  } catch {
    return undefined;
  }
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/rpc?token=${info.token}&client=mcp`);
  const ok = await new Promise<boolean>((resolve) => {
    ws.once("open", () => resolve(true));
    ws.once("error", () => resolve(false));
  });
  if (!ok) return undefined;
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as { id?: number; result?: unknown; error?: { category: string; message: string } };
    if (msg.id === undefined) return; // broadcast event
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(msg.error);
    else p.resolve(msg.result);
  });
  ws.on("close", () => {
    for (const p of pending.values()) p.reject({ category: "dependency_unavailable", message: "Lost connection to the Mantagli app" });
    pending.clear();
  });
  const call: CallFn = (name, input) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, {
        resolve: (r) => resolve(r as ToolResult),
        reject: (e) => resolve({ ok: false, error: e as ToolResult["error"] }),
      });
      ws.send(JSON.stringify({ id, method: "tools.call", params: { name, input } }));
    });
  return { call, close: () => ws.close() };
}

const app = await connectToApp();
let call: CallFn;
let mode: string;
if (app) {
  call = app.call;
  mode = "connected to the running Mantagli app";
} else {
  const engine = new Engine();
  await engine.init();
  call = (name, input) => executeTool({ engine, source: "mcp" }, name, input);
  mode = "standalone engine (open or create a project first)";
  const stop = async () => {
    await engine.closeProject();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.stdin.on("close", () => void stop());
}
console.error(`[mantagli-mcp] ${mode}`);

const server = new McpServer(
  { name: "mantagli", version: "0.1.0" },
  {
    instructions:
      "Mantagli is a 3D video montage editor. Start with project_get_state and capabilities. Timeline positions are integer frames at the project fps. Use audio_analyze for beat sync, timeline_place_sequence / edit_batch for bulk edits, scene_create for Blender 3D titles, preview_render to look at real rendered frames, and export_render + export_status to deliver. " +
      `Current mode: ${mode}.`,
  },
);

for (const def of TOOLS) {
  server.registerTool(
    def.name,
    { description: def.description, inputSchema: def.input.shape, annotations: { readOnlyHint: !def.mutates } },
    async (args: unknown) => {
      const r = await call(def.name, args);
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
        { type: "text", text: JSON.stringify(r.ok ? r.data : { error: r.error }, null, 1) },
      ];
      for (const img of r.images ?? []) {
        try {
          content.push({ type: "text", text: img.caption });
          content.push({ type: "image", data: (await readFile(img.path)).toString("base64"), mimeType: "image/png" });
        } catch {
          content.push({ type: "text", text: `(image unavailable: ${img.path})` });
        }
      }
      return { content, isError: !r.ok };
    },
  );
}

await server.connect(new StdioServerTransport());
