/**
 * Speak the promo's voice-over lines with every installed local engine (never a cloud one) and
 * measure them, so the voice is chosen from real output. WAVs stay in
 * tests/.tmp/promo-30s/voice-test/ for listening.
 *   npx tsx scripts/promo-30s/voices.ts
 */
import { copyFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { VO_LINES } from "./script.ts";

const ROOT = path.resolve(import.meta.dirname, "../../tests/.tmp/promo-30s/voice-test");
process.env.MANTAGLI_HOME = path.join(ROOT, "home");
const { Engine, executeTool } = await import("../../packages/engine/src/index.ts");
const engine = new Engine();
await engine.init();
await engine.config.update({ autoRenderScenes: false });
const tool = async (name: string, input: Record<string, unknown>) => {
  const r = await executeTool({ engine, source: "user" }, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.data as any;
};
await rm(path.join(ROOT, "Voices.mantagli"), { recursive: true, force: true });
await mkdir(ROOT, { recursive: true });
await engine.createProject({ name: "Voices", format: "vertical", parentDir: ROOT });
const providers = (await tool("voice_providers", {})).providers as { id: string; kind: string; quality: string; available: boolean; voices: { id: string; license?: string; language?: string }[] }[];
const candidates: [string, string | undefined][] = [];
for (const p of providers.filter((x) => x.kind === "local" && x.available)) {
  const en = p.voices.filter((v) => !v.license && (v.language ?? "").startsWith("en"));
  for (const v of (p.id === "rhvoice" ? en : en.slice(0, 1)).slice(0, 4)) candidates.push([p.id, v.id]);
  if (!en.length) candidates.push([p.id, undefined]);
}
for (const [provider, voice] of candidates) {
  const r = await tool("voice_narrate", { segments: VO_LINES.map((l) => ({ text: l.text })), provider, voice, rate: 1, place: false, captions: false });
  const rows: string[] = [];
  for (const [k, seg] of (r.segments as { path: string; seconds: number }[]).entries()) {
    const out = path.join(ROOT, `${provider}-${voice ?? "default"}-${k + 1}.wav`);
    await copyFile(seg.path, out);
    const log = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", out, "-af", "ebur128=peak=true,silencedetect=n=-45dB:d=0.35", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const sum = log.slice(log.lastIndexOf("Summary:"));
    const lufs = /I:\s*(-?[\d.]+)/.exec(sum)?.[1];
    const tp = /Peak:\s*(-?[\d.]+)/.exec(sum)?.[1];
    const gaps = (log.match(/silence_duration: ([\d.]+)/g) ?? []).map((g) => Number(g.split(": ")[1]).toFixed(2));
    rows.push(`${seg.seconds.toFixed(2)}s ${lufs}LUFS ${tp}dBTP gaps[${gaps.join(",")}]`);
  }
  console.log(`${provider}/${voice ?? "-"}: ${rows.join(" | ")}`);
}
await engine.closeProject();
process.exit(0);
