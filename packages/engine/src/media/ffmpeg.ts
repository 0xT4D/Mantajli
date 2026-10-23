import { spawn } from "node:child_process";
import { MantagliError } from "@mantagli/core";
import { run, type RunResult } from "../util/proc.js";

export interface FfmpegRunOptions {
  cwd?: string;
  /** Expected output duration, for progress. */
  durationSec?: number;
  onProgress?: (fraction: number, info: { frame?: number; speed?: string }) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Run ffmpeg with machine-readable progress on stdout. */
export async function runFfmpeg(ffmpeg: string, args: string[], opts: FfmpegRunOptions = {}): Promise<RunResult> {
  const fields: Record<string, string> = {};
  const r = await run(ffmpeg, ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", ...args], {
    cwd: opts.cwd,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    maxCapture: 64 * 1024,
    onStdoutLine: (line) => {
      const eq = line.indexOf("=");
      if (eq < 0) return;
      const k = line.slice(0, eq);
      fields[k] = line.slice(eq + 1);
      if (k === "progress" && opts.onProgress && opts.durationSec) {
        const us = Number(fields.out_time_us ?? fields.out_time_ms);
        if (Number.isFinite(us)) opts.onProgress(Math.min(1, us / 1e6 / opts.durationSec), { frame: Number(fields.frame), speed: fields.speed });
      }
    },
  });
  if (r.code !== 0) {
    const tail = r.stderr.trim().split(/\r?\n/).slice(-8).join("\n");
    throw new MantagliError("render_failed", `ffmpeg failed (exit ${r.code}): ${tail}`, { stderr: r.stderr.slice(-4000) });
  }
  return r;
}

/**
 * Stream-decode audio to mono float32 PCM at `sampleRate`, delivering chunks
 * so callers can aggregate without holding the whole file in memory.
 */
export function decodePcm(
  ffmpeg: string,
  file: string,
  sampleRate: number,
  onChunk: (samples: Float32Array) => void,
  opts: { maxSeconds?: number; signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(sampleRate)];
    if (opts.maxSeconds) args.push("-t", String(opts.maxSeconds));
    args.push("-f", "f32le", "pipe:1");
    const child = spawn(ffmpeg, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let leftover = Buffer.alloc(0);
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      const buf = leftover.length ? Buffer.concat([leftover, d]) : d;
      const usable = buf.length - (buf.length % 4);
      if (usable > 0) {
        const copy = new Float32Array(usable / 4);
        Buffer.from(copy.buffer).set(buf.subarray(0, usable));
        onChunk(copy);
      }
      leftover = Buffer.from(buf.subarray(usable));
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    const onAbort = () => child.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => reject(new MantagliError("dependency_unavailable", e.message)));
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) return reject(new MantagliError("cancelled", "Cancelled"));
      if (code !== 0) return reject(new MantagliError("render_failed", `Audio decode failed: ${stderr.trim()}`));
      resolve();
    });
  });
}
