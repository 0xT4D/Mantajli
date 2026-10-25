import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fail, newId, type CompositionPlan, type ExportSettings, type Project, type TextClip, type Asset } from "@mantagli/core";
import { filterGraphFileArgs, runFfmpeg } from "../media/ffmpeg.js";
import { exists } from "../util/fsx.js";
import { run } from "../util/proc.js";
import { buildGraph, type SceneFrames } from "./ffgraph.js";

export interface ComposeOptions {
  ffmpeg: string;
  project: Project;
  plan: CompositionPlan;
  scale: number;
  output: "video" | "still";
  outPath: string;
  workRoot: string;
  mediaPath(asset: Asset): string;
  sceneFrames(sceneId: string): SceneFrames | undefined;
  fontFile(clip: TextClip): string | undefined;
  encoding?: Pick<ExportSettings, "codec" | "crf" | "encoderPreset" | "audioBitrateK">;
  /** Draft previews favour speed over size/quality. */
  draft?: boolean;
  includeAudio?: boolean;
  /** Loudness target of the final mix (exports). */
  loudnessLufs?: number | null;
  /** Measured gain to the loudness target (see ffgraph `loudnessGainDb`). */
  loudnessGainDb?: number;
  signal?: AbortSignal;
  onProgress?: (f: number) => void;
  keepWorkDir?: boolean;
}

export async function compose(opts: ComposeOptions): Promise<{ outPath: string; frames: number; durationSec: number; width: number; height: number }> {
  const workDir = path.join(opts.workRoot, newId("work"));
  await mkdir(workDir, { recursive: true });
  const pending: Promise<void>[] = [];
  const graph = buildGraph({
    project: opts.project,
    plan: opts.plan,
    scale: opts.scale,
    mediaPath: opts.mediaPath,
    sceneFrames: opts.sceneFrames,
    fontFile: opts.fontFile,
    includeAudio: opts.includeAudio ?? opts.output === "video",
    loudnessLufs: opts.loudnessLufs,
    loudnessGainDb: opts.loudnessGainDb,
    output: opts.output,
    writeFile: (name, content) => void pending.push(writeFile(path.join(workDir, name), content, "utf8")),
  });
  await Promise.all(pending);
  await writeFile(path.join(workDir, "graph.txt"), graph.filter, "utf8");

  const args: string[] = [];
  for (const i of graph.inputs) args.push(...i);
  args.push(...(await filterGraphFileArgs(opts.ffmpeg, "graph.txt")), "-map", `[${graph.videoLabel}]`);
  if (graph.audioLabel) args.push("-map", `[${graph.audioLabel}]`);

  await mkdir(path.dirname(opts.outPath), { recursive: true });
  const ext = path.extname(opts.outPath).toLowerCase();
  const tmpOut = opts.outPath.replace(/(\.[^.]+)$/, `.partial$1`);
  if (opts.output === "still") {
    args.push("-frames:v", "1", "-update", "1", tmpOut);
  } else {
    const fpsR = `${opts.project.settings.fps.num}/${opts.project.settings.fps.den}`;
    const enc = opts.encoding ?? { codec: "h264", crf: 18, encoderPreset: "medium", audioBitrateK: 256 };
    args.push("-frames:v", String(graph.frames), "-r", fpsR);
    if (enc.codec === "prores") {
      if (ext !== ".mov") fail("invalid_params", "ProRes output must use .mov");
      args.push("-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le");
      if (graph.audioLabel) args.push("-c:a", "pcm_s16le");
    } else {
      const x = enc.codec === "h265" ? "libx265" : "libx264";
      args.push("-c:v", x, "-preset", opts.draft ? "ultrafast" : enc.encoderPreset, "-crf", String(opts.draft ? 26 : enc.crf), "-pix_fmt", "yuv420p");
      if (x === "libx264") args.push("-profile:v", "high");
      if (x === "libx265") args.push("-tag:v", "hvc1");
      if (graph.audioLabel) args.push("-c:a", "aac", "-b:a", `${opts.draft ? 160 : enc.audioBitrateK}k`);
      args.push("-movflags", "+faststart");
    }
    args.push("-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv");
    if (graph.audioLabel) args.push("-ar", "48000");
    args.push(tmpOut);
  }

  try {
    await runFfmpeg(opts.ffmpeg, args, {
      cwd: workDir,
      durationSec: graph.durationSec,
      onProgress: (f) => opts.onProgress?.(f),
      signal: opts.signal,
      timeoutMs: Math.max(120_000, graph.durationSec * 60_000),
    });
    if (!(await exists(tmpOut))) fail("render_failed", "FFmpeg reported success but wrote no output");
    const { rename } = await import("node:fs/promises");
    await rm(opts.outPath, { force: true });
    await rename(tmpOut, opts.outPath);
  } catch (e) {
    await rm(tmpOut, { force: true });
    throw e;
  } finally {
    if (!opts.keepWorkDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
  return { outPath: opts.outPath, frames: graph.frames, durationSec: graph.durationSec, width: graph.width, height: graph.height };
}

export interface OutputCheck {
  ok: boolean;
  width?: number;
  height?: number;
  duration?: number;
  frames?: number;
  videoCodec?: string;
  hasAudio: boolean;
  decodedSample: boolean;
  problems: string[];
}

/** Verify an exported file with ffprobe and decode a sample of frames. */
export async function verifyOutput(ffprobe: string, ffmpeg: string, file: string, expect: { width: number; height: number; durationSec: number; audio: boolean }): Promise<OutputCheck> {
  const problems: string[] = [];
  const r = await run(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-count_packets", file], { timeoutMs: 120000 });
  if (r.code !== 0) return { ok: false, hasAudio: false, decodedSample: false, problems: [`ffprobe could not read output: ${r.stderr.trim()}`] };
  const data = JSON.parse(r.stdout) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number; nb_read_packets?: string }[]; format: { duration?: string } };
  const v = data.streams.find((s) => s.codec_type === "video");
  const a = data.streams.find((s) => s.codec_type === "audio");
  const duration = Number(data.format.duration);
  if (!v) problems.push("no video stream");
  if (v && (v.width !== expect.width || v.height !== expect.height)) problems.push(`resolution ${v.width}x${v.height}, expected ${expect.width}x${expect.height}`);
  if (Math.abs(duration - expect.durationSec) > 0.15) problems.push(`duration ${duration.toFixed(3)}s, expected ${expect.durationSec.toFixed(3)}s`);
  if (expect.audio && !a) problems.push("missing audio stream");
  const mid = Math.max(0, duration / 2 - 0.1);
  const d = await run(ffmpeg, ["-hide_banner", "-v", "error", "-ss", mid.toFixed(3), "-i", file, "-frames:v", "5", "-f", "null", "-"], { timeoutMs: 60000 });
  const decodedSample = d.code === 0 && !d.stderr.trim();
  if (!decodedSample) problems.push(`sample decode failed: ${d.stderr.trim().slice(0, 300)}`);
  return {
    ok: problems.length === 0,
    width: v?.width,
    height: v?.height,
    duration,
    frames: v?.nb_read_packets ? Number(v.nb_read_packets) : undefined,
    videoCodec: v?.codec_name,
    hasAudio: !!a,
    decodedSample,
    problems,
  };
}
