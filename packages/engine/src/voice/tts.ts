/**
 * Text-to-speech providers behind one interface. Local engines run on this machine:
 * Windows SAPI (System.Speech, the voices installed in Windows), eSpeak NG, and FFmpeg's flite
 * filter (when FFmpeg is built with libflite). Cloud engines (OpenAI, ElevenLabs) are used only
 * when their API key is set in the engine's environment; the script text is then sent to that
 * provider. Keys never reach the UI.
 *
 * Every provider writes a WAV; `finishSpeech` then trims the silence around it, converts to
 * 48 kHz stereo and levels it for dialogue (-16 LUFS), so all voices sit alike in the mix.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fail, MantagliError } from "@mantagli/core";
import { findOnPath } from "../config.js";
import { runFfmpeg } from "../media/ffmpeg.js";
import { run } from "../util/proc.js";

export interface TtsVoice {
  id: string;
  name: string;
  language?: string;
  gender?: string;
}

export interface TtsRequest {
  text: string;
  voice?: string;
  /** Speaking rate relative to the voice's normal speed (0.5–2). */
  rate?: number;
  /** Pitch shift in semitones where the engine supports it (eSpeak, SAPI via SSML). */
  pitch?: number;
  /** Delivery hint for engines that take one (OpenAI `instructions`), e.g. "calm documentary narrator". */
  style?: string;
}

export interface TtsProvider {
  id: TtsProviderId;
  label: string;
  kind: "local" | "cloud";
  /** Whether it can run here, and why not. */
  status(): Promise<{ available: boolean; reason?: string }>;
  voices(): Promise<TtsVoice[]>;
  /** Write raw speech (any WAV the engine produces) to `out`. */
  synthesize(req: TtsRequest, out: string, signal?: AbortSignal): Promise<void>;
}

export const TTS_PROVIDER_IDS = ["sapi", "espeak", "flite", "openai", "elevenlabs"] as const;
export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number];

const clampRate = (r?: number) => Math.min(2, Math.max(0.5, r ?? 1));

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mantagli-tts-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ Windows SAPI

/** PowerShell for System.Speech; text and voice are read from files (no quoting of user text). */
export function sapiScript(textFile: string, out: string, opts: { voiceFile?: string; rate: number; ssml: boolean }): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    opts.voiceFile ? `$s.SelectVoice((Get-Content -Raw -Encoding UTF8 ${q(opts.voiceFile)}).Trim())` : "",
    // SAPI rate: -10..10, roughly 10 % per step around normal speed.
    `$s.Rate = ${Math.round(Math.max(-10, Math.min(10, (opts.rate - 1) * 10)))}`,
    `$s.SetOutputToWaveFile(${q(out)})`,
    `$t = Get-Content -Raw -Encoding UTF8 ${q(textFile)}`,
    opts.ssml ? "$s.SpeakSsml($t)" : "$s.Speak($t)",
    "$s.Dispose()",
  ]
    .filter(Boolean)
    .join("; ");
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const sapi: TtsProvider = {
  id: "sapi",
  label: "Windows voices (SAPI, local)",
  kind: "local",
  async status() {
    return process.platform === "win32" ? { available: true } : { available: false, reason: "Windows only" };
  },
  async voices() {
    if (process.platform !== "win32") return [];
    const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture + '|' + $_.VoiceInfo.Gender }"], { timeoutMs: 30000 });
    return r.stdout
      .split(/\r?\n/)
      .filter((l) => l.includes("|"))
      .map((l) => {
        const [name, language, gender] = l.trim().split("|");
        return { id: name!, name: name!, language, gender };
      });
  },
  async synthesize(req, out, signal) {
    await withTemp(async (dir) => {
      const textFile = path.join(dir, "text.txt");
      const pitch = req.pitch ? Math.round(req.pitch * 6) : 0; // SSML prosody pitch in %, ~6 % per semitone
      const ssml = pitch !== 0;
      const text = ssml
        ? `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><prosody pitch="${pitch >= 0 ? "+" : ""}${pitch}%">${xmlEscape(req.text)}</prosody></speak>`
        : req.text;
      await writeFile(textFile, text, "utf8");
      let voiceFile: string | undefined;
      if (req.voice) await writeFile((voiceFile = path.join(dir, "voice.txt")), req.voice, "utf8");
      const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", sapiScript(textFile, out, { voiceFile, rate: clampRate(req.rate), ssml })], { timeoutMs: 120000, signal });
      if (r.code !== 0) fail("dependency_unavailable", `Windows speech failed: ${r.stderr.trim().slice(-300)}`);
    });
  },
};

// ------------------------------------------------------------------ eSpeak NG

let espeakBin: string | null | undefined;
async function espeak(): Promise<string | undefined> {
  if (espeakBin === undefined) espeakBin = (await findOnPath("espeak-ng")) ?? (await findOnPath("espeak")) ?? null;
  return espeakBin ?? undefined;
}

const espeakProvider: TtsProvider = {
  id: "espeak",
  label: "eSpeak NG (local, robotic)",
  kind: "local",
  async status() {
    return (await espeak()) ? { available: true } : { available: false, reason: "espeak-ng is not installed" };
  },
  async voices() {
    const bin = await espeak();
    if (!bin) return [];
    const r = await run(bin, ["--voices"], { timeoutMs: 15000 });
    return r.stdout
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length >= 4)
      .map((c) => ({ id: c[1]!, name: `${c[3]!.replace(/_/g, " ")} (${c[1]})`, language: c[1], gender: c[2]?.split("/")[1] }));
  },
  async synthesize(req, out, signal) {
    const bin = (await espeak()) ?? fail("dependency_unavailable", "espeak-ng is not installed");
    await withTemp(async (dir) => {
      const textFile = path.join(dir, "text.txt");
      await writeFile(textFile, req.text, "utf8");
      const args = ["-v", req.voice ?? "en-us", "-s", String(Math.round(165 * clampRate(req.rate))), "-p", String(Math.round(Math.max(0, Math.min(99, 50 + (req.pitch ?? 0) * 4)))), "-w", out, "-f", textFile];
      const r = await run(bin, args, { timeoutMs: 120000, signal });
      if (r.code !== 0) fail("dependency_unavailable", `espeak-ng failed: ${r.stderr.trim().slice(-300)}`);
    });
  },
};

// ------------------------------------------------------------------ FFmpeg flite

const FLITE_VOICES: TtsVoice[] = [
  { id: "slt", name: "SLT (female, US)", language: "en-us", gender: "F" },
  { id: "rms", name: "RMS (male, US)", language: "en-us", gender: "M" },
  { id: "awb", name: "AWB (male, Scottish)", language: "en-gb", gender: "M" },
  { id: "kal16", name: "KAL (male, US)", language: "en-us", gender: "M" },
];

let fliteOk: Promise<boolean> | undefined;
function fliteAvailable(ffmpeg: string): Promise<boolean> {
  fliteOk ??= run(ffmpeg, ["-hide_banner", "-filters"], { timeoutMs: 15000 }).then((r) => /\bflite\b/.test(r.stdout), () => false);
  return fliteOk;
}

function fliteProvider(ffmpeg: string): TtsProvider {
  return {
    id: "flite",
    label: "Flite via FFmpeg (local, robotic)",
    kind: "local",
    async status() {
      return (await fliteAvailable(ffmpeg)) ? { available: true } : { available: false, reason: "this FFmpeg build has no flite filter" };
    },
    async voices() {
      return (await fliteAvailable(ffmpeg)) ? FLITE_VOICES : [];
    },
    async synthesize(req, out, signal) {
      await withTemp(async (dir) => {
        const textFile = path.join(dir, "text.txt");
        await writeFile(textFile, req.text, "utf8");
        const voice = FLITE_VOICES.some((v) => v.id === req.voice) ? req.voice! : "slt";
        const rate = clampRate(req.rate);
        // flite has no rate control: tempo change without pitch change.
        await runFfmpeg(ffmpeg, ["-f", "lavfi", "-i", `flite=textfile=${textFile.replace(/\\/g, "/").replace(/:/g, "\\:")}:voice=${voice}`, ...(rate !== 1 ? ["-af", `atempo=${rate}`] : []), out], { signal, timeoutMs: 120000 });
      });
    },
  };
}

// ------------------------------------------------------------------ cloud providers

const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];

async function httpError(provider: string, res: Response): Promise<never> {
  const body = (await res.text().catch(() => "")).slice(0, 300);
  const category = res.status === 401 || res.status === 403 ? "permission_denied" : "dependency_unavailable";
  const hint = res.status === 429 ? " (rate limited or out of quota)" : res.status === 401 ? " (check the API key)" : "";
  throw new MantagliError(category, `${provider} returned ${res.status}${hint}${body ? `: ${body}` : ""}`);
}

const openai: TtsProvider = {
  id: "openai",
  label: "OpenAI TTS (cloud, needs OPENAI_API_KEY)",
  kind: "cloud",
  async status() {
    return process.env.OPENAI_API_KEY ? { available: true } : { available: false, reason: "set OPENAI_API_KEY in the engine's environment" };
  },
  async voices() {
    return OPENAI_VOICES.map((v) => ({ id: v, name: v }));
  },
  async synthesize(req, out, signal) {
    const key = process.env.OPENAI_API_KEY ?? fail("dependency_unavailable", "OPENAI_API_KEY is not set");
    const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    const res = await fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.MANTAGLI_OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts",
        input: req.text,
        voice: OPENAI_VOICES.includes(req.voice ?? "") ? req.voice : "alloy",
        response_format: "wav",
        speed: clampRate(req.rate),
        ...(req.style ? { instructions: req.style } : {}),
      }),
      signal,
    }).catch((e: Error) => fail("dependency_unavailable", `OpenAI TTS unreachable: ${e.message}`));
    if (!res.ok) await httpError("OpenAI TTS", res);
    await writeFile(out, Buffer.from(await res.arrayBuffer()));
  },
};

const elevenlabs: TtsProvider = {
  id: "elevenlabs",
  label: "ElevenLabs (cloud, needs ELEVENLABS_API_KEY)",
  kind: "cloud",
  async status() {
    return process.env.ELEVENLABS_API_KEY ? { available: true } : { available: false, reason: "set ELEVENLABS_API_KEY in the engine's environment" };
  },
  async voices() {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return [];
    const base = process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io";
    const res = await fetch(`${base}/v1/voices`, { headers: { "xi-api-key": key } }).catch(() => undefined);
    if (!res?.ok) return [];
    const data = (await res.json()) as { voices?: { voice_id: string; name: string; labels?: Record<string, string> }[] };
    return (data.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name, language: v.labels?.language, gender: v.labels?.gender }));
  },
  async synthesize(req, out, signal) {
    const key = process.env.ELEVENLABS_API_KEY ?? fail("dependency_unavailable", "ELEVENLABS_API_KEY is not set");
    if (!req.voice) fail("invalid_params", "ElevenLabs needs a voice id (see voice_providers)");
    const base = process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io";
    const res = await fetch(`${base}/v1/text-to-speech/${encodeURIComponent(req.voice)}?output_format=pcm_44100`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text: req.text, model_id: process.env.MANTAGLI_ELEVENLABS_MODEL ?? "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: Math.min(1.2, Math.max(0.7, clampRate(req.rate))) } }),
      signal,
    }).catch((e: Error) => fail("dependency_unavailable", `ElevenLabs unreachable: ${e.message}`));
    if (!res.ok) await httpError("ElevenLabs", res);
    // Raw 16-bit mono PCM at 44.1 kHz: wrap it in a WAV header.
    await writeFile(out, pcmWav(Buffer.from(await res.arrayBuffer()), 44100, 1));
  },
};

/** 16-bit little-endian PCM → WAV. */
export function pcmWav(pcm: Buffer, rate: number, channels: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export function ttsProviders(ffmpeg: string): TtsProvider[] {
  return [sapi, espeakProvider, fliteProvider(ffmpeg), openai, elevenlabs];
}

/** First available provider, local ones first. */
/** The first available local provider. Cloud providers are never a default: script text leaves the machine only when one is named. */
export async function defaultTtsProvider(ffmpeg: string): Promise<TtsProvider | undefined> {
  for (const p of ttsProviders(ffmpeg)) if (p.kind === "local" && (await p.status()).available) return p;
  return undefined;
}

/** Dialogue level of every synthesized line. */
export const SPEECH_LUFS = -16;

/**
 * Trim leading/trailing silence, convert to 48 kHz stereo 16-bit and level to SPEECH_LUFS
 * (dialogue), keeping 80 ms of air at each end: measure, apply one gain through a true-peak
 * limiter, measure the result and correct once. (Single-pass loudnorm works on a 3 s window
 * and left 2 s lines 2-4 LU short.)
 */
export async function finishSpeech(ffmpeg: string, raw: string, out: string, signal?: AbortSignal): Promise<void> {
  const trim = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08";
  const trimmed = `${trim},areverse,${trim},areverse`;
  const loudness = async (file: string, pre: string) => {
    const r = await runFfmpeg(ffmpeg, ["-i", file, "-af", `${pre}ebur128`, "-f", "null", "-"], { signal, timeoutMs: 120000 });
    const v = Number(/I:\s*(-?[\d.]+) LUFS/.exec(r.stderr.slice(r.stderr.lastIndexOf("Summary:")))?.[1]);
    return Number.isFinite(v) && v > -70 ? v : undefined;
  };
  const render = (gain: number) =>
    runFfmpeg(ffmpeg, ["-i", raw, "-af", `${trimmed},aresample=192000,volume=${gain.toFixed(2)}dB,alimiter=limit=0.841:attack=2:release=40:level=0,aresample=48000`, "-ac", "2", "-c:a", "pcm_s16le", out], { signal, timeoutMs: 120000 });
  const measured = await loudness(raw, `${trimmed},`);
  let gain = measured === undefined ? 0 : Math.min(30, SPEECH_LUFS - measured);
  await render(gain);
  // Speech peaks sit ~18 dB over its loudness, so the limiter takes ~1 LU back: measure once and correct.
  const got = measured === undefined ? undefined : await loudness(out, "");
  if (got !== undefined && Math.abs(SPEECH_LUFS - got) > 0.3) {
    gain = Math.min(30, gain + SPEECH_LUFS - got);
    await render(gain);
  }
  const head = await readFile(out).then((b) => b.length).catch(() => 0);
  if (head < 1000) fail("render_failed", "Speech synthesis produced no audio");
}
