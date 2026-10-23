import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, findAsset, MantagliError, type Project, type Scene } from "@mantagli/core";
import { ensureDir, exists, sha1, writeFileAtomic } from "../util/fsx.js";
import { run } from "../util/proc.js";

export type SceneQuality = "draft" | "final";

export function blenderScriptPath(): string {
  if (process.env.MANTAGLI_BLENDER_SCRIPT) return process.env.MANTAGLI_BLENDER_SCRIPT;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/render -> repo/blender (dev) ; bundled builds set MANTAGLI_BLENDER_SCRIPT
  return path.resolve(here, "../../../../blender/mantagli_scene.py");
}

export interface SceneJobSpec {
  project: Project;
  scene: Scene;
  quality: SceneQuality;
  /** Fraction of project resolution. */
  resolutionScale: number;
  defaultFont?: string;
}

/**
 * Cache key: everything that affects the pixels of a scene render. Any edit
 * to the scene, project format, quality or referenced files changes the key,
 * which invalidates the cached frames.
 */
export function sceneRenderKey(spec: SceneJobSpec): string {
  const { scene, project } = spec;
  const files: Record<string, string> = {};
  for (const o of scene.objects) {
    const ids = [o.model?.assetId, o.text?.fontAssetId].filter(Boolean) as string[];
    for (const id of ids) {
      const a = findAsset(project, id);
      if (a) files[id] = a.hash;
    }
  }
  const { name: _name, ...pixels } = scene;
  return sha1(
    JSON.stringify({
      v: 2,
      pixels,
      w: project.settings.width,
      h: project.settings.height,
      fps: project.settings.fps,
      q: spec.quality,
      s: spec.resolutionScale,
      files,
      font: spec.defaultFont,
    }),
  ).slice(0, 16);
}

export async function existingFrames(dir: string): Promise<Set<number>> {
  const set = new Set<number>();
  try {
    for (const n of await readdir(dir)) {
      const m = /^frame_(\d{5})\.png$/.exec(n);
      if (m) {
        const s = await stat(path.join(dir, n));
        if (s.size > 0) set.add(Number(m[1]));
      }
    }
  } catch {
    /* no dir yet */
  }
  return set;
}

/** Collapse a sorted frame list into inclusive ranges. */
export function toRanges(frames: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const f of frames) {
    const last = out[out.length - 1];
    if (last && f === last[1] + 1) last[1] = f;
    else out.push([f, f]);
  }
  return out;
}

export interface BlenderRunOptions {
  blender: string;
  outputDir: string;
  /** 1-based scene frames to ensure exist. */
  frames: number[];
  saveBlend?: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  onLog?: (line: string) => void;
  /** Per-frame time budget (ms). */
  frameTimeoutMs?: number;
}

/**
 * Render the requested frames of a scene with Blender in background mode.
 * Frames already on disk are skipped, so interrupted renders resume.
 */
export async function renderSceneFrames(spec: SceneJobSpec, opts: BlenderRunOptions): Promise<{ rendered: number; skipped: number; warnings: string[]; cyclesDevice?: string }> {
  const have = await existingFrames(opts.outputDir);
  const wanted = [...new Set(opts.frames)].filter((f) => f >= 1 && f <= spec.scene.durationFrames).sort((a, b) => a - b);
  const missing = wanted.filter((f) => !have.has(f));
  const warnings: string[] = [];
  if (missing.length === 0 && !opts.saveBlend) return { rendered: 0, skipped: wanted.length, warnings };

  await ensureDir(opts.outputDir);
  if (opts.saveBlend) await ensureDir(path.dirname(opts.saveBlend));
  const assets: Record<string, string> = {};
  const fonts: Record<string, string> = {};
  for (const o of spec.scene.objects) {
    if (o.model) {
      const a = findAsset(spec.project, o.model.assetId);
      if (!a || a.status !== "ok") fail("missing_asset", `Model for "${o.name}" is missing`);
      assets[a.id] = a.path;
    }
    if (o.text?.fontAssetId) {
      const a = findAsset(spec.project, o.text.fontAssetId);
      if (a?.status === "ok") fonts[a.id] = a.path;
    }
  }
  const job = {
    scene: spec.scene,
    width: spec.project.settings.width,
    height: spec.project.settings.height,
    fps: spec.project.settings.fps,
    resolutionScale: spec.resolutionScale,
    quality: spec.quality,
    assets,
    fonts,
    defaultFont: spec.defaultFont,
    outputDir: opts.outputDir,
    frames: toRanges(missing),
    saveBlend: opts.saveBlend,
  };
  const jobFile = path.join(opts.outputDir, "job.json");
  await writeFileAtomic(jobFile, JSON.stringify(job));
  const script = blenderScriptPath();
  if (!(await exists(script))) fail("dependency_unavailable", `Blender scene script not found at ${script}`);

  let error: { message: string; trace?: string } | undefined;
  let cyclesDevice: string | undefined;
  const timeout = 90_000 + missing.length * (opts.frameTimeoutMs ?? 180_000);
  const r = await run(opts.blender, ["-b", "--factory-startup", "--python-exit-code", "1", "-P", script, "--", jobFile], {
    signal: opts.signal,
    timeoutMs: timeout,
    onStdoutLine: (line) => {
      if (line.startsWith("MANTAGLI_FRAME ")) {
        const [, done, total] = line.slice(15).split(" ").map(Number);
        opts.onProgress?.(done!, total!);
      } else if (line.startsWith("MANTAGLI_INFO ")) {
        try {
          cyclesDevice = (JSON.parse(line.slice(14)) as { cyclesDevice?: string }).cyclesDevice ?? cyclesDevice;
        } catch {
          // informational only
        }
      } else if (line.startsWith("MANTAGLI_WARN ")) {
        warnings.push(line.slice(14));
      } else if (line.startsWith("MANTAGLI_ERROR ")) {
        try {
          error = JSON.parse(line.slice(15));
        } catch {
          error = { message: line.slice(15) };
        }
      }
      opts.onLog?.(line);
    },
  });
  if (r.code !== 0 || error) {
    throw new MantagliError("render_failed", `Blender failed: ${error?.message ?? r.stderr.trim().split("\n").slice(-5).join(" ")}`, { trace: error?.trace });
  }
  // Validate every requested frame exists before reporting success.
  const after = await existingFrames(opts.outputDir);
  const stillMissing = wanted.filter((f) => !after.has(f));
  if (stillMissing.length) fail("render_failed", `Blender finished but ${stillMissing.length} frame(s) are missing (first: ${stillMissing[0]})`);
  return { rendered: missing.length, skipped: wanted.length - missing.length, warnings, cyclesDevice };
}
