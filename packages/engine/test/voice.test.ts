import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TMP } from "./fixtures.js";
import { captionChunks, captionCues, estimateSpeechSeconds } from "../src/voice/narration.js";

process.env.MANTAGLI_HOME = path.join(TMP, "home-voice");
const { Engine } = await import("../src/engine.js");
const { executeTool } = await import("../src/ai/tools.js");
const { defaultTtsProvider, pcmWav } = await import("../src/voice/tts.js");

const engine = new Engine();
const ROOT = path.join(TMP, "voice");
const tool = async (name: string, input: Record<string, unknown>) => executeTool({ engine, source: "ai" }, name, input);

/** Peak level of an audio file in dBFS (FFmpeg volumedetect). */
function maxVolume(file: string): number {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/max_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1] ?? NaN);
}

beforeAll(async () => {
  await engine.init();
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
}, 120_000);
afterAll(async () => {
  await engine.closeProject();
});

describe("narration helpers", () => {
  it("splits scripts into readable caption chunks and spreads cues over the real length", () => {
    const text = "Seventh edition. Workshops, CTF battles and a treasure hunt that takes the whole night, so bring snacks! See you there.";
    const chunks = captionChunks(text, 42);
    expect(chunks.every((c) => c.length <= 42)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text);
    expect(chunks[0]).toBe("Seventh edition.");
    const cues = captionCues(text, 9.5);
    expect(cues[0]!.start).toBe(0);
    expect(cues.at(-1)!.end).toBeCloseTo(9.5, 6);
    for (let k = 1; k < cues.length; k++) expect(cues[k]!.start).toBeCloseTo(cues[k - 1]!.end, 9);
    // Longer text takes longer; faster delivery shortens it.
    expect(estimateSpeechSeconds(text)).toBeGreaterThan(estimateSpeechSeconds("Seventh edition."));
    expect(estimateSpeechSeconds(text, 1.5)).toBeLessThan(estimateSpeechSeconds(text));
  });
});

describe("voice-over workflow (local engine)", () => {
  it("speaks a script onto a dialogue track with captions and music ducking, and re-voices one segment", async () => {
    await engine.createProject({ name: "Voice", format: "vertical", parentDir: ROOT });
    const s = engine.requireSession();
    const local = await defaultTtsProvider(engine.ffmpeg);
    if (!local) {
      // No local engine on this machine: the tool must say so instead of producing silence.
      const r = await tool("voice_narrate", { segments: [{ text: "Hello." }] });
      expect(r.ok).toBe(false);
      expect(r.error?.category).toBe("dependency_unavailable");
      return;
    }
    const providers = await tool("voice_providers", {});
    expect((providers.data as { providers: { id: string; available: boolean }[] }).providers.find((p) => p.id === local.id)?.available).toBe(true);

    const music = await tool("music_generate", { style: "cinematic", mood: "tense", duration: 12 });
    expect(music.ok, JSON.stringify(music.error)).toBe(true);

    const segments = [{ text: "This year, the arena opens again." }, { text: "Seventh edition. Workshops, battles, and a treasure hunt." }];
    const dry = await tool("voice_narrate", { segments, start: 15, dryRun: true });
    expect(dry.ok).toBe(true);
    const r = await tool("voice_narrate", { segments, start: 15, gapSeconds: 0.5 });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    const data = r.data as { trackId: string; captionTrackId: string; segments: { clipId: string; assetId: string; start: number; frames: number; captions: number }[]; ducking: boolean };
    const track = s.project.tracks.find((t) => t.id === data.trackId)!;
    expect(track.role).toBe("dialogue");
    expect(data.ducking).toBe(true);
    const [a, b] = data.segments;
    expect(a!.start).toBe(15);
    expect(b!.start).toBe(15 + a!.frames + 15); // 0.5 s gap at 30 fps
    for (const seg of data.segments) {
      const asset = s.project.assets.find((x) => x.id === seg.assetId)!;
      expect(asset.tags).toContain(`tts:${local.id}`);
      expect(seg.frames).toBe(Math.round(asset.meta.duration! * 30));
      expect(asset.meta.duration!).toBeGreaterThan(0.8);
      expect(maxVolume(asset.path)).toBeGreaterThan(-6); // levelled speech, not silence
      // Captions cover the segment exactly.
      const caps = s.project.tracks.find((t) => t.id === data.captionTrackId)!.clips.filter((c) => c.start >= seg.start && c.start < seg.start + seg.frames);
      expect(caps.length).toBe(seg.captions);
      expect(caps[0]!.start).toBe(seg.start);
      expect(Math.max(...caps.map((c) => c.start + c.duration))).toBeLessThanOrEqual(seg.start + seg.frames);
    }

    // Same text again: cached audio (no new asset).
    const assets = s.project.assets.length;
    await tool("voice_narrate", { segments: [segments[0]!], start: 400, captions: false });
    expect(s.project.assets.length).toBe(assets);

    // Re-voice the second segment: same start, new length, captions retimed.
    const rv = await tool("voice_regenerate", { clipId: b!.clipId, text: "Seventh edition. Join us." });
    expect(rv.ok, JSON.stringify(rv.error)).toBe(true);
    const nv = rv.data as { clipId: string; start: number; frames: number; captions: number };
    expect(nv.start).toBe(b!.start);
    expect(nv.frames).toBeLessThan(b!.frames);
    const capTrack = s.project.tracks.find((t) => t.id === data.captionTrackId)!;
    const retimed = capTrack.clips.filter((c) => c.start >= b!.start && c.start < b!.start + b!.frames);
    expect(retimed.map((c) => c.type === "text" && c.text)).toEqual(["Seventh edition.", "Join us."]);
  }, 180_000);
});

describe("cloud voice providers (against a local mock of their APIs)", () => {
  let server: http.Server;
  const seen: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  let status = 200;
  beforeAll(async () => {
    const tone = Buffer.alloc(44100 * 2); // 1 s of 16-bit mono
    for (let i = 0; i < 44100; i++) tone.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 44100) * 12000), i * 2);
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", headers: req.headers, body });
        if (status !== 200) return res.writeHead(status, { "Content-Type": "application/json" }).end('{"error":"invalid key"}');
        if (req.url?.startsWith("/v1/audio/speech")) return res.writeHead(200, { "Content-Type": "audio/wav" }).end(pcmWav(tone, 44100, 1));
        if (req.url?.startsWith("/v1/text-to-speech/")) return res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(tone);
        if (req.url === "/v1/voices") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ voices: [{ voice_id: "v123", name: "Narrator", labels: { gender: "female" } }] }));
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.ELEVENLABS_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.ELEVENLABS_API_KEY = "el-test";
  });
  afterAll(async () => {
    for (const k of ["OPENAI_BASE_URL", "ELEVENLABS_BASE_URL", "OPENAI_API_KEY", "ELEVENLABS_API_KEY"]) delete process.env[k];
    await new Promise((r) => server.close(r));
  });

  it("sends the documented request, levels the result and reports auth failures", async () => {
    // Keys present, yet the default is never a cloud provider: text leaves the machine only when one is named.
    expect((await defaultTtsProvider(engine.ffmpeg))?.kind ?? "local").toBe("local");
    await engine.createProject({ name: "Cloud voice", format: "landscape", parentDir: ROOT });
    const r = await tool("voice_narrate", { segments: [{ text: "Premium, minimal, quiet." }], provider: "openai", voice: "coral", rate: 1.1, style: "calm documentary narrator", captions: false });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    const req = seen.find((x) => x.url === "/v1/audio/speech")!;
    expect(req.headers.authorization).toBe("Bearer sk-test");
    expect(JSON.parse(req.body)).toMatchObject({ input: "Premium, minimal, quiet.", voice: "coral", response_format: "wav", speed: 1.1, instructions: "calm documentary narrator" });
    const seg = (r.data as { segments: { frames: number }[] }).segments[0]!;
    expect(seg.frames).toBeGreaterThan(20); // ~1 s tone after trimming

    const el = await tool("voice_narrate", { segments: [{ text: "Hello there." }], provider: "elevenlabs", voice: "v123", start: 200, captions: false });
    expect(el.ok, JSON.stringify(el.error)).toBe(true);
    const elReq = seen.find((x) => x.url.startsWith("/v1/text-to-speech/v123"))!;
    expect(elReq.headers["xi-api-key"]).toBe("el-test");
    expect(elReq.url).toContain("output_format=pcm_44100");
    expect(JSON.parse(elReq.body).text).toBe("Hello there.");
    const voices = await tool("voice_providers", {});
    expect((voices.data as { providers: { id: string; voices: { id: string }[] }[] }).providers.find((p) => p.id === "elevenlabs")!.voices[0]!.id).toBe("v123");

    const noVoice = await tool("voice_narrate", { segments: [{ text: "x y z" }], provider: "elevenlabs", captions: false });
    expect(noVoice.error?.category).toBe("invalid_params");
    status = 401;
    const denied = await tool("voice_narrate", { segments: [{ text: "Different text, so not cached." }], provider: "openai", start: 400, captions: false });
    status = 200;
    expect(denied.ok).toBe(false);
    expect(denied.error?.category).toBe("permission_denied");
    expect(denied.error?.message).toMatch(/401/);
  }, 120_000);
});
