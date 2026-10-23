import { mkdir } from "node:fs/promises";
import path from "node:path";
import { run } from "../src/util/proc.js";
import { exists } from "../src/util/fsx.js";

export const TMP = path.resolve(import.meta.dirname, "../../../tests/.tmp");
export const FIXTURES = path.join(TMP, "media");

async function ff(args: string[]) {
  const r = await run("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args], { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error(r.stderr);
}

/** Generate small real media files with FFmpeg (once). */
export async function makeFixtures(): Promise<{ video: string; video2: string; music: string; image: string }> {
  await mkdir(FIXTURES, { recursive: true });
  const video = path.join(FIXTURES, "clip_a.mp4");
  const video2 = path.join(FIXTURES, "clip_b.mp4");
  const music = path.join(FIXTURES, "music_120bpm.wav");
  const image = path.join(FIXTURES, "still.png");
  if (!(await exists(video)))
    await ff(["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=6", "-f", "lavfi", "-i", "sine=f=440:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
  if (!(await exists(video2)))
    await ff(["-f", "lavfi", "-i", "mandelbrot=s=960x540:r=25", "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", video2]);
  if (!(await exists(music)))
    // Kick on every beat at 120 BPM plus a quieter off-beat hat.
    await ff([
      "-f", "lavfi",
      "-i", "aevalsrc='0.9*sin(2*PI*55*t)*exp(-30*mod(t,0.5))+0.15*(random(0)-0.5)*exp(-80*mod(t+0.25,0.5))':s=44100:d=12",
      "-ac", "2", music,
    ]);
  if (!(await exists(image))) await ff(["-f", "lavfi", "-i", "testsrc=s=800x800", "-frames:v", "1", image]);
  return { video, video2, music, image };
}
