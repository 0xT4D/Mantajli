import { EventEmitter } from "node:events";
import { MantagliError, newId, toErrorPayload, type ErrorCategory } from "@mantagli/core";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type JobLane = "heavy" | "light";

export interface JobInfo {
  id: string;
  type: string;
  label: string;
  key?: string;
  lane: JobLane;
  status: JobStatus;
  /** 0–1, or null when the job cannot estimate progress. */
  progress: number | null;
  message?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  outputs: string[];
  error?: { category: ErrorCategory; message: string };
  result?: unknown;
}

export interface JobContext {
  signal: AbortSignal;
  progress(fraction: number | null, message?: string): void;
  addOutput(path: string): void;
}

interface Entry {
  info: JobInfo;
  run: (ctx: JobContext) => Promise<unknown>;
  controller: AbortController;
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const LANE_CONCURRENCY: Record<JobLane, number> = { heavy: 1, light: 3 };

/**
 * Background job queue with two lanes (heavy renders run one at a time, light
 * media tasks a few at a time), de-duplication by key, progress events and
 * cancellation through AbortSignal.
 */
export class JobManager extends EventEmitter {
  private entries = new Map<string, Entry>();
  private order: string[] = [];

  submit<T>(spec: { type: string; label: string; key?: string; lane?: JobLane }, run: (ctx: JobContext) => Promise<T>): { job: JobInfo; promise: Promise<T> } {
    if (spec.key) {
      const dup = [...this.entries.values()].find((e) => e.info.key === spec.key && (e.info.status === "queued" || e.info.status === "running"));
      if (dup) return { job: dup.info, promise: dup.promise as Promise<T> };
    }
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Avoid unhandled rejections for fire-and-forget jobs; callers that await still see the error.
    promise.catch(() => {});
    const info: JobInfo = {
      id: newId("job"),
      type: spec.type,
      label: spec.label,
      key: spec.key,
      lane: spec.lane ?? "light",
      status: "queued",
      progress: 0,
      createdAt: new Date().toISOString(),
      outputs: [],
    };
    const entry: Entry = { info, run: run as (ctx: JobContext) => Promise<unknown>, controller: new AbortController(), promise, resolve, reject };
    this.entries.set(info.id, entry);
    this.order.push(info.id);
    this.trim();
    this.emitUpdate(info);
    this.pump();
    return { job: info, promise: promise as Promise<T> };
  }

  get(id: string): JobInfo | undefined {
    return this.entries.get(id)?.info;
  }

  wait(id: string): Promise<unknown> {
    const e = this.entries.get(id);
    if (!e) return Promise.reject(new MantagliError("not_found", `Job ${id} not found`));
    return e.promise;
  }

  list(): JobInfo[] {
    return this.order.map((id) => this.entries.get(id)!.info).reverse();
  }

  cancel(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    if (e.info.status === "queued") {
      this.finish(e, "cancelled", undefined, new MantagliError("cancelled", "Cancelled"));
      return true;
    }
    if (e.info.status === "running") {
      e.controller.abort();
      return true;
    }
    return false;
  }

  cancelAll(): void {
    for (const e of this.entries.values()) this.cancel(e.info.id);
  }

  private running(lane: JobLane): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.info.lane === lane && e.info.status === "running") n++;
    return n;
  }

  private pump(): void {
    for (const lane of ["heavy", "light"] as JobLane[]) {
      while (this.running(lane) < LANE_CONCURRENCY[lane]) {
        const next = this.order.map((id) => this.entries.get(id)!).find((e) => e.info.lane === lane && e.info.status === "queued");
        if (!next) break;
        void this.start(next);
      }
    }
  }

  private async start(e: Entry): Promise<void> {
    e.info.status = "running";
    e.info.startedAt = new Date().toISOString();
    this.emitUpdate(e.info);
    let lastEmit = 0;
    const ctx: JobContext = {
      signal: e.controller.signal,
      progress: (fraction, message) => {
        e.info.progress = fraction === null ? null : Math.max(0, Math.min(1, fraction));
        if (message !== undefined) e.info.message = message;
        const now = Date.now();
        if (now - lastEmit > 150) {
          lastEmit = now;
          this.emitUpdate(e.info);
        }
      },
      addOutput: (p) => {
        e.info.outputs.push(p);
      },
    };
    try {
      const result = await e.run(ctx);
      if (e.controller.signal.aborted) throw new MantagliError("cancelled", "Cancelled");
      this.finish(e, "done", result);
    } catch (err) {
      const cancelled = e.controller.signal.aborted || (err instanceof MantagliError && err.category === "cancelled");
      this.finish(e, cancelled ? "cancelled" : "failed", undefined, err);
    }
  }

  private finish(e: Entry, status: JobStatus, result?: unknown, err?: unknown): void {
    e.info.status = status;
    e.info.finishedAt = new Date().toISOString();
    if (status === "done") {
      e.info.progress = 1;
      e.info.result = result;
      e.resolve(result);
    } else {
      const payload = toErrorPayload(err);
      e.info.error = { category: status === "cancelled" ? "cancelled" : payload.category, message: payload.message };
      e.reject(err instanceof MantagliError ? err : new MantagliError(e.info.error.category, e.info.error.message));
    }
    this.emitUpdate(e.info);
    this.emit("finished", e.info);
    this.pump();
  }

  private trim(): void {
    // Keep the last 200 finished jobs.
    const finished = this.order.filter((id) => {
      const s = this.entries.get(id)!.info.status;
      return s === "done" || s === "failed" || s === "cancelled";
    });
    for (const id of finished.slice(0, Math.max(0, finished.length - 200))) {
      this.entries.delete(id);
      this.order = this.order.filter((x) => x !== id);
    }
  }

  private emitUpdate(info: JobInfo): void {
    this.emit("update", { ...info, outputs: [...info.outputs] });
  }
}
