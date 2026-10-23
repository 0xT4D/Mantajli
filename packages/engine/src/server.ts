import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { fail, MantagliError, toErrorPayload, type CommandName, type FormatPreset } from "@mantagli/core";
import { appDataDir } from "./config.js";
import { Director } from "./ai/director.js";
import { executeTool, TOOLS, toolJsonSchema } from "./ai/tools.js";
import { Engine } from "./engine.js";
import { availableFontFamilies } from "./render/fonts.js";
import { ProjectSession } from "./session.js";
import { isInside, writeFileAtomic } from "./util/fsx.js";

export const ENGINE_INFO_FILE = () => path.join(appDataDir(), "engine.json");
export const ENGINE_VERSION = "0.1.0";

type Handler = (params: Record<string, unknown>, client: Client) => Promise<unknown> | unknown;

interface Client {
  ws: WebSocket;
  kind: "ui" | "mcp";
}

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".m4v": "video/mp4", ".mkv": "video/x-matroska",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac", ".opus": "audio/ogg",
  ".json": "application/json",
};

/**
 * Engine host: JSON-RPC over WebSocket plus a file endpoint for media
 * playback, bound to 127.0.0.1 and protected by a random bearer token.
 */
export class EngineServer {
  readonly token: string;
  readonly director: Director;
  private server?: http.Server;
  private wss?: WebSocketServer;
  private clients = new Set<Client>();
  port = 0;

  constructor(
    readonly engine: Engine,
    opts: { token?: string } = {},
  ) {
    this.token = opts.token ?? randomBytes(24).toString("hex");
    this.director = new Director(engine);
    engine.on("change", (c) => this.broadcast("project", { project: c.project, label: c.label, source: c.source, kind: c.kind, canUndo: engine.session?.history.canUndo(), canRedo: engine.session?.history.canRedo() }));
    engine.on("saveState", (s) => this.broadcast("saveState", { state: s, error: engine.session?.lastSaveError }));
    engine.on("job", (j) => this.broadcast("job", j));
    engine.on("deps", (d) => this.broadcast("deps", d));
    engine.on("projectOpened", (p) => this.broadcast("projectOpened", { ...this.sessionInfo(), recoveredFrom: p.recoveredFrom }));
    engine.on("projectClosed", () => this.broadcast("projectClosed", {}));
    this.director.on("event", (e) => this.broadcast("ai.event", e));
    this.director.on("run", (r) => this.broadcast("ai.run", r));
  }

  private sessionInfo() {
    const s = this.engine.session;
    if (!s) return { open: false };
    return { open: true, dir: s.dir, project: s.project, saveState: s.saveState, canUndo: s.history.canUndo(), canRedo: s.history.canRedo(), recoveredFrom: s.recoveredFrom };
  }

  private checkToken(t: string | null | undefined): boolean {
    if (!t) return false;
    const a = Buffer.from(t);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ------------------------------------------------------------ RPC methods

  private readonly methods: Record<string, Handler> = {
    "app.info": () => ({
      version: ENGINE_VERSION,
      deps: this.engine.deps,
      settings: this.engine.config.settings,
      projectsDir: this.engine.config.projectsDir,
      session: this.sessionInfo(),
      ai: { hasKey: !!process.env.ANTHROPIC_API_KEY, model: this.engine.config.settings.aiModel },
      platform: process.platform,
    }),
    "app.refreshDeps": () => this.engine.refreshDependencies(),
    "app.updateSettings": async (p) => {
      const s = await this.engine.config.update(p.patch as never);
      if ("blenderPath" in (p.patch as object) || "ffmpegPath" in (p.patch as object)) await this.engine.refreshDependencies();
      return s;
    },
    "app.fonts": () => availableFontFamilies(),

    "project.create": async (p) => {
      await this.engine.createProject({ name: String(p.name), format: p.format as FormatPreset, fps: p.fps as never, parentDir: p.parentDir as string | undefined });
      return this.sessionInfo();
    },
    "project.open": async (p) => {
      await this.engine.openProject(String(p.path), { force: !!p.force });
      return this.sessionInfo();
    },
    "project.close": async () => {
      await this.engine.closeProject();
      return { ok: true };
    },
    "project.state": () => this.sessionInfo(),
    "project.save": async () => {
      await this.engine.requireSession().save({ backup: true });
      return { ok: true };
    },
    "project.dispatch": (p) => this.engine.requireSession().dispatch(p.name as CommandName, p.params as never, "user", p.label as string | undefined),
    "project.transaction": (p) => {
      const cmds = p.commands as { name: CommandName; params: unknown }[];
      return this.engine.requireSession().transaction(String(p.label ?? "Edit"), "user", (tx) => cmds.map((c) => tx.dispatch(c.name, c.params as never)));
    },
    "project.undo": () => this.engine.requireSession().undo() ?? null,
    "project.redo": () => this.engine.requireSession().redo() ?? null,
    "project.history": () => this.engine.requireSession().history.list(),
    "project.oplog": () => this.engine.requireSession().readOpLog(),
    "project.backups": async () => ProjectSession.listBackups(this.engine.requireSession().dir),

    "media.import": (p) => this.engine.importMedia(p.paths as string[], "user"),
    "media.relink": (p) => this.engine.relinkAsset(String(p.assetId), String(p.path)),
    "media.refreshStatus": () => this.engine.requireSession().refreshAssetStatus(),
    "media.ensureDerived": async (p) => {
      await this.engine.ensureDerived(String(p.assetId));
      return { ok: true };
    },
    "media.analyzeBeats": (p) => this.engine.analyzeBeats(String(p.assetId), { applyMarkers: p.applyMarkers !== false, source: "user" }),
    "media.waveform": async (p) => {
      const s = this.engine.requireSession();
      const a = s.project.assets.find((x) => x.id === p.assetId) ?? fail("not_found", "Asset not found");
      if (!a.derived.waveform) return null;
      return JSON.parse(await readFile(s.resolveInProject(a.derived.waveform), "utf8"));
    },

    "render.still": (p) => this.engine.renderStill(Number(p.frame), { scale: p.scale as number | undefined }),
    "render.range": (p) => this.engine.renderPreviewRange(Number(p.start), Number(p.end), { scale: p.scale as number | undefined }),
    "render.scene": (p) => this.engine.renderScene(String(p.sceneId), { quality: (p.quality as "draft" | "final") ?? "draft", scale: Number(p.scale ?? 0.5), frames: p.frames as number[] | undefined }),
    "render.validate": (p) => this.engine.validateRender({ preset: p.preset as string | undefined }),
    "render.export": (p) => {
      const { job } = this.engine.startExport({ preset: p.preset as string | undefined, outPath: p.outPath as string | undefined, range: p.range as never });
      return job;
    },

    "jobs.list": () => this.engine.jobs.list(),
    "jobs.cancel": (p) => this.engine.jobs.cancel(String(p.jobId)),

    "ai.setApiKey": (p) => {
      // Held in memory for this process only; persistence is the desktop shell's keychain.
      const key = String(p.key ?? "").trim();
      if (key) process.env.ANTHROPIC_API_KEY = key;
      else delete process.env.ANTHROPIC_API_KEY;
      return { hasKey: !!key };
    },
    "ai.start": (p) => this.director.start(String(p.brief), { autonomy: p.autonomy as "review" | "autonomous" | undefined }),
    "ai.cancel": (p) => this.director.cancel(String(p.runId)),
    "ai.approve": (p) => this.director.respondApproval(String(p.approvalId), !!p.approved),
    "ai.revert": (p) => (this.director.revert(String(p.runId)), { ok: true }),
    "ai.accept": (p) => (this.director.accept(String(p.runId)), { ok: true }),
    "ai.runs": () => this.director.list(),
    "ai.reset": () => (this.director.resetConversation(), { ok: true }),

    "tools.list": () => TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: toolJsonSchema(t), mutates: t.mutates })),
    "tools.call": (p, client) => executeTool({ engine: this.engine, source: client.kind === "mcp" ? "mcp" : "user" }, String(p.name), p.input),
  };

  async handle(msg: { id?: number | string; method?: string; params?: Record<string, unknown> }, client: Client): Promise<unknown> {
    const fn = msg.method ? this.methods[msg.method] : undefined;
    if (!fn) throw new MantagliError("unsupported", `Unknown method ${msg.method}`);
    return fn(msg.params ?? {}, client);
  }

  broadcast(event: string, data: unknown): void {
    const payload = JSON.stringify({ event, data });
    for (const c of this.clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
  }

  // ------------------------------------------------------------ HTTP file serving

  /** Only files inside the project folder or the project's own asset files are served. */
  private allowedFile(file: string): boolean {
    const s = this.engine.session;
    if (!s) return false;
    const abs = path.resolve(file);
    if (isInside(s.dir, abs)) return true;
    return s.project.assets.some((a) => path.resolve(a.path) === abs);
  }

  private async serveFile(req: http.IncomingMessage, res: http.ServerResponse, file: string): Promise<void> {
    if (!this.allowedFile(file)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    let st;
    try {
      st = await stat(file);
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const range = req.headers.range;
    const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" };
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m?.[1] ? Number(m[1]) : 0;
      let end = m?.[2] ? Number(m[2]) : st.size - 1;
      if (!m?.[1] && m?.[2]) {
        start = st.size - Number(m[2]);
        end = st.size - 1;
      }
      if (start >= st.size || end >= st.size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${st.size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": String(end - start + 1) });
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, "Content-Length": String(st.size) });
      createReadStream(file).pipe(res);
    }
  }

  // ------------------------------------------------------------ lifecycle

  async listen(port = 0): Promise<number> {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, version: ENGINE_VERSION }));
        return;
      }
      if (!this.checkToken(url.searchParams.get("token"))) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      if (url.pathname === "/file") {
        void this.serveFile(req, res, url.searchParams.get("path") ?? "").catch(() => res.writeHead(500).end());
        return;
      }
      res.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/rpc" || !this.checkToken(url.searchParams.get("token"))) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        const client: Client = { ws, kind: url.searchParams.get("client") === "mcp" ? "mcp" : "ui" };
        this.clients.add(client);
        ws.on("close", () => this.clients.delete(client));
        ws.on("message", async (raw) => {
          let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
          try {
            msg = JSON.parse(String(raw));
          } catch {
            return;
          }
          try {
            const result = await this.handle(msg, client);
            ws.send(JSON.stringify({ id: msg.id, result: result ?? null }));
          } catch (e) {
            ws.send(JSON.stringify({ id: msg.id, error: toErrorPayload(e) }));
          }
        });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
    await writeFileAtomic(ENGINE_INFO_FILE(), JSON.stringify({ port: this.port, token: this.token, pid: process.pid, version: ENGINE_VERSION }));
    return this.port;
  }

  async close(): Promise<void> {
    for (const r of this.director.list()) this.director.cancel(r.id);
    this.engine.jobs.cancelAll();
    await this.engine.closeProject();
    for (const c of this.clients) c.ws.close();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    try {
      const info = JSON.parse(await readFile(ENGINE_INFO_FILE(), "utf8")) as { pid: number };
      if (info.pid === process.pid) await rm(ENGINE_INFO_FILE(), { force: true });
    } catch {
      /* already gone */
    }
  }
}
