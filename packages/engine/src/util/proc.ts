import { spawn } from "node:child_process";
import { MantagliError } from "@mantagli/core";

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Keep at most this many bytes of output for error reports. */
  maxCapture?: number;
  stdin?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function killTree(pid: number) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run an executable with an argument array (never through a shell), with
 * timeout, cancellation and line-based output streaming.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const max = opts.maxCapture ?? 256 * 1024;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new MantagliError("cancelled", "Cancelled before start"));
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: [opts.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outBuf = "";
    let errBuf = "";
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    const lines = (buf: string, chunk: string, cb?: (l: string) => void): string => {
      buf += chunk;
      const parts = buf.split(/\r\n|\n|\r/);
      buf = parts.pop() ?? "";
      if (cb) for (const l of parts) cb(l);
      return buf;
    };
    child.stdout!.setEncoding("utf8").on("data", (d: string) => {
      if (stdout.length < max) stdout += d;
      outBuf = lines(outBuf, d, opts.onStdoutLine);
    });
    child.stderr!.setEncoding("utf8").on("data", (d: string) => {
      stderr = (stderr + d).slice(-max);
      errBuf = lines(errBuf, d, opts.onStderrLine);
    });
    if (opts.stdin !== undefined) {
      child.stdin!.end(opts.stdin);
    }

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (child.pid) killTree(child.pid);
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => {
      cancelled = true;
      if (child.pid) killTree(child.pid);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    child.on("error", (e) =>
      finish(() => reject(new MantagliError("dependency_unavailable", `Failed to start ${cmd}: ${e.message}`))),
    );
    child.on("close", (code) =>
      finish(() => {
        if (outBuf && opts.onStdoutLine) opts.onStdoutLine(outBuf);
        if (errBuf && opts.onStderrLine) opts.onStderrLine(errBuf);
        if (cancelled) return reject(new MantagliError("cancelled", "Process cancelled"));
        if (timedOut) return reject(new MantagliError("render_failed", `Process timed out after ${opts.timeoutMs} ms`));
        resolve({ code: code ?? -1, stdout, stderr });
      }),
    );
  });
}
