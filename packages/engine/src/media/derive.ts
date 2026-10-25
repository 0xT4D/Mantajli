import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Asset, BeatAnalysis } from "@mantagli/core";
import { ensureDir, writeFileAtomic } from "../util/fsx.js";
import { AudioAccumulator, ANALYSIS_SR, detectBeats, type BeatResult, type WaveformData } from "./audioAnalysis.js";
import { decodePcm, runFfmpeg } from "./ffmpeg.js";

const PROXY_HEIGHT = 540;

export async function makeThumbnail(ffmpeg: string, asset: Asset, out: string, signal?: AbortSignal): Promise<string> {
  await ensureDir(path.dirname(out));
  const args: string[] = [];
  if (asset.kind === "video") {
    const t = Math.min(Math.max(0.2, (asset.meta.duration ?? 1) * 0.15), Math.max(0, (asset.meta.duration ?? 1) - 0.1));
    args.push("-ss", t.toFixed(3));
  }
  args.push("-i", asset.path, "-frames:v", "1", "-vf", "scale='min(480,iw)':-2:flags=bicubic", "-q:v", "4", out);
  await runFfmpeg(ffmpeg, args, { signal, timeoutMs: 60000 });
  return out;
}

/** Horizontal strip of key-frame thumbnails, decoding only key frames. */
export async function makeFilmstrip(ffmpeg: string, asset: Asset, out: string, signal?: AbortSignal): Promise<string> {
  await ensureDir(path.dirname(out));
  const dur = Math.max(0.5, asset.meta.duration ?? 1);
  const n = 12;
  // Long files: decode key frames only (fast). Short files may have a single
  // key frame, so decode everything. tpad guarantees the tile always fills.
  const pre = dur > 60 ? ["-skip_frame", "nokey"] : [];
  await runFfmpeg(
    ffmpeg,
    [...pre, "-i", asset.path, "-vf", `fps=${(n / dur).toFixed(5)},scale=-2:72,tpad=stop_mode=clone:stop=${n},tile=${n}x1`, "-frames:v", "1", "-fps_mode", "vfr", "-q:v", "5", out],
    { signal, timeoutMs: 180000 },
  );
  return out;
}

/**
 * Browser-friendly editing proxy: H.264, 540p, short GOP for fast scrubbing.
 */
export async function makeProxy(ffmpeg: string, asset: Asset, out: string, onProgress: (f: number) => void, signal?: AbortSignal): Promise<string> {
  await ensureDir(path.dirname(out));
  const tmp = out.replace(/\.mp4$/, ".partial.mp4");
  await runFfmpeg(
    ffmpeg,
    [
      "-i", asset.path,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", `scale=-2:'min(${PROXY_HEIGHT},ih)':flags=bicubic,format=yuv420p`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-g", "12", "-bf", "0",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      "-movflags", "+faststart",
      tmp,
    ],
    { signal, durationSec: asset.meta.duration, onProgress: (f) => onProgress(f) },
  );
  const { rename } = await import("node:fs/promises");
  await rename(tmp, out);
  return out;
}

export interface AudioAnalysisOutput {
  waveform: WaveformData;
  beats?: BeatResult;
}

/** One decoding pass that yields the waveform and, optionally, beats. */
export async function analyzeAudio(
  ffmpeg: string,
  asset: Asset,
  opts: { beats: boolean; waveformOut?: string; signal?: AbortSignal; onProgress?: (f: number) => void },
): Promise<AudioAnalysisOutput> {
  const acc = new AudioAccumulator(opts.beats);
  const total = (asset.meta.duration ?? 0) * ANALYSIS_SR;
  await decodePcm(
    ffmpeg,
    asset.path,
    ANALYSIS_SR,
    (chunk) => {
      acc.push(chunk);
      if (total && opts.onProgress) opts.onProgress(Math.min(0.95, acc.samples / total));
    },
    { signal: opts.signal, maxSeconds: 60 * 60 },
  );
  const waveform = acc.waveform();
  if (opts.waveformOut) await writeFileAtomic(opts.waveformOut, JSON.stringify(waveform));
  return { waveform, ...(opts.beats ? { beats: detectBeats(acc.envelope, { rms: acc.rms, bright: acc.bright }) } : {}) };
}

export function toBeatAnalysis(b: BeatResult): BeatAnalysis {
  return {
    bpm: b.bpm,
    times: b.beats,
    strengths: b.strengths,
    downbeats: b.downbeats,
    onsets: b.onsets,
    sections: b.sections,
    confidence: b.confidence,
    analyzedAt: new Date().toISOString(),
  };
}

export async function readWaveform(file: string): Promise<WaveformData> {
  return JSON.parse(await readFile(file, "utf8")) as WaveformData;
}
