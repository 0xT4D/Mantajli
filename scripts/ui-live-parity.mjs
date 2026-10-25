// Live preview vs exact render: builds one small project per effect case through the engine,
// captures the viewer's live canvas (~60 ms after stepping) and the exact FFmpeg frame, and
// reports how far apart they are. Needs the engine and Vite running (see NEXT_SESSION.md).
// Usage: node scripts/ui-live-parity.mjs [outDir] [url]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { launchBrowser } from "./browser.mjs";

const out = path.resolve(process.argv[2] ?? "tests/.tmp/live-parity");
mkdirSync(out, { recursive: true });
const home =
  process.env.MANTAGLI_HOME ??
  (process.platform === "win32" ? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Mantagli") : path.join(os.homedir(), ".config", "mantagli"));
const { port, token } = JSON.parse(readFileSync(path.join(home, "engine.json"), "utf8"));
const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${token}`);
await new Promise((r) => ws.once("open", r));
let nextId = 1;
const pending = new Map();
ws.on("message", (m) => {
  const msg = JSON.parse(String(m));
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
});
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const tool = async (name, input) => {
  const r = await call("tools.call", { name, input });
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.data;
};

/** Decode a PNG to RGB with FFmpeg. */
function rgb(file) {
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" }).trim().split(",").map(Number);
  const buf = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 28 });
  return { w, h, buf };
}
const meanAbsDiff = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.buf.length; i++) s += Math.abs(a.buf[i] - b.buf[i]);
  return s / a.buf.length;
};
/** Standard deviation of luma in the central quarter (noise level on a flat clip). */
const centreStd = (img) => {
  const v = [];
  for (let y = Math.floor(img.h * 0.375); y < img.h * 0.625; y++)
    for (let x = Math.floor(img.w * 0.375); x < img.w * 0.625; x++) {
      const i = (y * img.w + x) * 3;
      v.push(0.2126 * img.buf[i] + 0.7152 * img.buf[i + 1] + 0.0722 * img.buf[i + 2]);
    }
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
};

const dir = path.join(out, "projects");
mkdirSync(dir, { recursive: true });
const media = path.resolve("tests/.tmp/media/still.png");
const cases = [
  { name: "vignette", effects: [["vignette", { amount: 0.8 }]] },
  { name: "lens", effects: [["lensDistortion", { amount: 0.6 }]] },
  { name: "aberration", effects: [["chromaticAberration", { pixels: 12 }]] },
  { name: "grain", effects: [["grain", { amount: 30 }]], flat: true },
  { name: "crtLook", look: "crtMonitor" },
];

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const results = [];
for (const c of cases) {
  await call("project.create", { name: `Parity ${c.name} ${Date.now() % 100000}`, format: "landscape", parentDir: dir });
  const st = await tool("project_get_state", { includeValidation: false });
  const v1 = st.tracks.find((t) => t.name === "V1").id;
  let clipId;
  if (c.flat) clipId = (await tool("timeline_add_clip", { trackId: v1, type: "color", fill: "#808080", start: 0, duration: 30 })).clipId;
  else {
    const imp = await call("media.import", { paths: [media] }); // the UI's import (no AI media boundary)
    clipId = (await tool("timeline_add_clip", { trackId: v1, type: "media", assetId: imp.imported[0].id, start: 0, duration: 30, transform: { fit: "fill" } })).clipId;
  }
  if (c.look) await tool("look_apply", { clipIds: [clipId], look: c.look });
  for (const [type, params] of c.effects ?? []) await tool("effect_add", { clipId, type, params });

  await page.goto(process.argv[3] ?? "http://127.0.0.1:1420/");
  await page.waitForTimeout(2500);
  const box = page.locator("canvas").first().locator("..");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(80);
  const live = path.join(out, `${c.name}-live.png`);
  await box.screenshot({ path: live });
  await page.locator("text=Rendered frame · exact").first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(300);
  const exact = path.join(out, `${c.name}-exact.png`);
  await box.screenshot({ path: exact });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", live, "-i", exact, "-filter_complex", "hstack", path.join(out, `${c.name}-side.png`)]);
  const a = rgb(live);
  const b = rgb(exact);
  const r = { case: c.name, meanAbsDiff: +meanAbsDiff(a, b).toFixed(2) };
  if (c.flat) Object.assign(r, { liveNoiseStd: +centreStd(a).toFixed(2), exactNoiseStd: +centreStd(b).toFixed(2) });
  results.push(r);
  console.log(JSON.stringify(r));
}
writeFileSync(path.join(out, "parity.json"), JSON.stringify({ results, consoleErrors: errors }, null, 1));
console.log(errors.length ? `console errors: ${errors.length}` : "no console errors");
await browser.close();
ws.close();
