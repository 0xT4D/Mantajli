#!/usr/bin/env node
/**
 * Regenerate the reference-video frame sheets used by REFERENCE_VIDEO_ANALYSIS.md.
 *
 *   node scripts/reference-frames.mjs            # writes docs/reference/*.jpg
 *
 * Needs ffmpeg on PATH and the videos in example_videos/. Output: one 1-fps
 * contact sheet per video and consecutive-frame strips around key transitions.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const src = path.join(root, "example_videos");
const out = path.join(root, "docs", "reference");
mkdirSync(out, { recursive: true });

const stamp = "drawtext=text='%{pts\\:flt}':x=4:y=4:fontsize=16:fontcolor=yellow:box=1:boxcolor=black@0.6";
function ff(args) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

const videos = ["Cybercamp7_Teaser", "Securinets_Quals_Teaser_HQ", "tga_teaser"];
for (const v of videos) {
  const file = path.join(src, `${v}.mp4`);
  if (!existsSync(file)) {
    console.warn(`missing ${file}`);
    continue;
  }
  ff(["-i", file, "-vf", `fps=1,scale=216:-2,${stamp.replace("flt", "hms")},tile=10x6`, "-frames:v", "1", "-q:v", "4", path.join(out, `${v}_sheet.jpg`)]);
}

// [video, start s, length s, fps, name] — strips of 10 frames around transitions.
const strips = [
  ["Cybercamp7_Teaser", 4.2, 2, 5, "cc_portal"],
  ["Cybercamp7_Teaser", 10.6, 2, 5, "cc_dive"],
  ["Cybercamp7_Teaser", 14.6, 2, 5, "cc_turntable"],
  ["Cybercamp7_Teaser", 26.4, 2, 5, "cc_grid"],
  ["Cybercamp7_Teaser", 42.2, 2.5, 4, "cc_level7"],
  ["Securinets_Quals_Teaser_HQ", 6.4, 1.6, 6.25, "sq_earth"],
  ["Securinets_Quals_Teaser_HQ", 19.0, 2.5, 4, "sq_flash"],
  ["Securinets_Quals_Teaser_HQ", 30.8, 1.6, 6.25, "sq_whip"],
  ["Securinets_Quals_Teaser_HQ", 41.4, 1.2, 8.3, "sq_glitch"],
  ["tga_teaser", 4.8, 0.67, 15, "tga_glitch"],
  ["tga_teaser", 37.6, 1.6, 6.25, "tga_flash"],
];
for (const [v, ss, t, fps, name] of strips) {
  const file = path.join(src, `${v}.mp4`);
  if (!existsSync(file)) continue;
  ff(["-ss", String(ss), "-i", file, "-t", String(t), "-vf", `fps=${fps},scale=200:-2,${stamp},tile=10x1`, "-frames:v", "1", "-q:v", "4", path.join(out, `${name}.jpg`)]);
}
console.log(`wrote frame sheets to ${out}`);
