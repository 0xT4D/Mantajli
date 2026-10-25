import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type RGB = [number, number, number];

export interface Pixels {
  w: number;
  h: number;
  at: (x: number, y: number) => RGB;
}

/** Decode an image to raw RGB with FFmpeg. */
export async function pixels(file: string): Promise<Pixels> {
  const probe = await promisify(execFile)("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
  const [w, h] = probe.stdout.trim().split(",").map(Number) as [number, number];
  const { stdout } = await promisify(execFile)("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 64 << 20 });
  const buf = stdout as Buffer;
  return { w, h, at: (x, y) => [buf[(Math.floor(y) * w + Math.floor(x)) * 3]!, buf[(Math.floor(y) * w + Math.floor(x)) * 3 + 1]!, buf[(Math.floor(y) * w + Math.floor(x)) * 3 + 2]!] };
}

/** Decode every frame of a video to RGB (small renders only). */
export async function videoPixels(file: string): Promise<Pixels[]> {
  const probe = await promisify(execFile)("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
  const [w, h] = probe.stdout.trim().split(",").map(Number) as [number, number];
  const { stdout } = await promisify(execFile)("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 1 << 30 });
  const buf = stdout as Buffer;
  const size = w * h * 3;
  const out: Pixels[] = [];
  for (let o = 0; o + size <= buf.length; o += size) {
    const base = o;
    out.push({ w, h, at: (x, y) => { const i = base + (Math.floor(y) * w + Math.floor(x)) * 3; return [buf[i]!, buf[i + 1]!, buf[i + 2]!]; } });
  }
  return out;
}

/** Bounding box of pixels matching `test` (default: bright). */
export function bbox(px: Pixels, test: (c: RGB) => boolean = ([r, g, b]) => r + g + b > 600) {
  let [x0, x1, y0, y1] = [px.w, -1, px.h, -1];
  for (let y = 0; y < px.h; y++)
    for (let x = 0; x < px.w; x++)
      if (test(px.at(x, y))) [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
  return { found: x1 >= 0, x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2 };
}

/** Mean absolute difference (0–255) between two equally sized images. */
export function meanDiff(a: Pixels, b: Pixels): number {
  let s = 0;
  for (let y = 0; y < a.h; y++)
    for (let x = 0; x < a.w; x++) {
      const p = a.at(x, y);
      const q = b.at(x, y);
      s += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
    }
  return s / (a.w * a.h * 3);
}

export const luma = ([r, g, b]: RGB) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
