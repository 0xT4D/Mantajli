import type { ErrorCategory } from "@mantagli/core";
import { getEngineConnection, type EngineConnection } from "../lib/platform";

export class EngineError extends Error {
  constructor(
    public category: ErrorCategory,
    message: string,
  ) {
    super(message);
  }
}

type Listener = (data: unknown) => void;

/** JSON-RPC client for the engine host, with automatic reconnect. */
export class EngineClient {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private listeners = new Map<string, Set<Listener>>();
  conn?: EngineConnection;
  connected = false;

  async connect(): Promise<void> {
    this.conn = await getEngineConnection();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.conn!.port}/rpc?token=${this.conn!.token}`);
      ws.onopen = () => {
        this.ws = ws;
        this.connected = true;
        this.emit("connection", true);
        resolve();
      };
      ws.onerror = () => reject(new Error("Could not connect to the Mantagli engine"));
      ws.onclose = () => {
        const was = this.connected;
        this.connected = false;
        for (const p of this.pending.values()) p.reject(new EngineError("dependency_unavailable", "Engine connection lost"));
        this.pending.clear();
        if (was) {
          this.emit("connection", false);
          setTimeout(() => void this.connect().catch(() => {}), 1500);
        }
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { category: ErrorCategory; message: string }; event?: string; data?: unknown };
        if (msg.event) {
          this.emit(msg.event, msg.data);
          return;
        }
        const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
        if (!p) return;
        this.pending.delete(msg.id!);
        if (msg.error) p.reject(new EngineError(msg.error.category, msg.error.message));
        else p.resolve(msg.result);
      };
    });
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || !this.connected) return Promise.reject(new EngineError("dependency_unavailable", "Engine is not connected"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, cb: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  private emit(event: string, data: unknown) {
    for (const cb of this.listeners.get(event) ?? []) cb(data);
  }

  /** URL for streaming a local file (project cache or asset) to <img>/<video>. */
  fileUrl(path: string | undefined, bust?: string | number): string | undefined {
    if (!path || !this.conn) return undefined;
    return `http://127.0.0.1:${this.conn.port}/file?token=${this.conn.token}&path=${encodeURIComponent(path)}${bust !== undefined ? `&v=${bust}` : ""}`;
  }
}

export const engine = new EngineClient();
