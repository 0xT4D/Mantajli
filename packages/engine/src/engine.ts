import { EventEmitter } from "node:events";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  AssetSchema,
  buildCompositionPlan,
  fail,
  findAsset,
  findScene,
  fpsValue,
  newId,
  projectDuration,
  secondsToFrames,
  validateProject,
  type Asset,
  type BeatAnalysis,
  type ChangeSource,
  type CompositionPlan,
  type FormatPreset,
  type Project,
  type Rational,
  type TextClip,
  type ValidationIssue,
} from "@mantagli/core";
import { AppConfig, discoverDependencies, type DependencyStatus } from "./config.js";
import { JobManager, type JobContext, type JobInfo } from "./jobs.js";
import { analyzeAudio, makeFilmstrip, makeProxy, makeThumbnail, toBeatAnalysis } from "./media/derive.js";
import { kindFromExtension, probeMedia, SUPPORTED_EXTENSIONS } from "./media/probe.js";
import { existingFrames, renderSceneFrames, sceneRenderKey, type SceneQuality } from "./render/blender.js";
import { compose, verifyOutput, type OutputCheck } from "./render/compose.js";
import { RENDERER_VERSION } from "./render/ffgraph.js";
import { defaultFontFile, resolveFontFile } from "./render/fonts.js";
import { ProjectSession } from "./session.js";
import { exists, quickHash, safeName, sha1, writeFileAtomic } from "./util/fsx.js";
import { encodeWav, synthesizeSfx, type SfxKind, type SfxOptions } from "./media/sfx.js";
import { generateMusic, type MusicOptions, type MusicResult } from "./media/music.js";
import { defaultTtsProvider, finishSpeech, ttsProviders, type TtsProviderId, type TtsRequest } from "./voice/tts.js";
import { runFfmpeg } from "./media/ffmpeg.js";

export const EXPORT_PRESET_SIZES: Record<string, { width: number; height: number; codec?: "prores" }> = {
  reel1080: { width: 1080, height: 1920 },
  square1080: { width: 1080, height: 1080 },
  landscape1080: { width: 1920, height: 1080 },
  landscape4k: { width: 3840, height: 2160 },
  reel4k: { width: 2160, height: 3840 },
  master: { width: 0, height: 0, codec: "prores" },
};

export interface ImportResult {
  imported: Asset[];
  duplicates: { path: string; assetId: string }[];
  errors: { path: string; category: string; message: string }[];
}

export interface ExportResult {
  outPath: string;
  check: OutputCheck;
  warnings: string[];
  durationSec: number;
}

/**
 * The application engine: one instance per process. Owns the open project
 * session, background jobs, dependency discovery and every media/render
 * operation. UI (via RPC), the AI director and MCP all call into this.
 */
export class Engine extends EventEmitter {
  readonly config = new AppConfig();
  readonly jobs = new JobManager();
  deps: DependencyStatus = { problems: ["not checked yet"] };
  session?: ProjectSession;
  private fontCache = new Map<string, string | undefined>();
  private sceneAutoTimer?: NodeJS.Timeout;
  /** sceneId -> running/queued auto-preview job (cancelled when superseded). */
  private sceneAutoJobs = new Map<string, { jobId: string; dir: string }>();
  /** Delay after the last edit before auto-rendering 3D previews. */
  sceneAutoDelayMs = 2500;
  private defaultFont?: string;
  private default3dFont?: string;

  async init(): Promise<void> {
    await this.config.load();
    await this.refreshDependencies();
    this.defaultFont = await defaultFontFile(true);
    this.default3dFont = (await resolveFontFile("Arial Black", true)) ?? this.defaultFont;
    this.jobs.on("update", (j: JobInfo) => this.emit("job", j));
  }

  async refreshDependencies(): Promise<DependencyStatus> {
    this.deps = await discoverDependencies(this.config.settings);
    this.emit("deps", this.deps);
    return this.deps;
  }

  get ffmpeg(): string {
    return this.deps.ffmpeg?.path ?? fail("dependency_unavailable", "FFmpeg is not available");
  }
  get ffprobe(): string {
    return this.deps.ffprobe?.path ?? fail("dependency_unavailable", "FFprobe is not available");
  }
  get blender(): string {
    return this.deps.blender?.path ?? fail("dependency_unavailable", "Blender is not available; set its path in Settings to render 3D scenes");
  }

  requireSession(): ProjectSession {
    return this.session ?? fail("not_found", "No project is open");
  }

  get project(): Project {
    return this.requireSession().project;
  }

  // ------------------------------------------------------------ projects

  private attach(s: ProjectSession) {
    this.session = s;
    s.on("change", (c) => {
      this.emit("change", c);
      this.scheduleSceneAutoRender();
    });
    s.on("saveState", (st) => this.emit("saveState", st));
    this.emit("projectOpened", { dir: s.dir, project: s.project, recoveredFrom: s.recoveredFrom });
    void this.config.addRecent(s.dir);
  }

  async createProject(opts: { name: string; format?: FormatPreset; fps?: Rational; parentDir?: string }): Promise<ProjectSession> {
    await this.closeProject();
    const s = await ProjectSession.create(opts.parentDir ?? this.config.projectsDir, { name: opts.name, format: opts.format, fps: opts.fps });
    this.attach(s);
    return s;
  }

  async openProject(target: string, opts: { force?: boolean } = {}): Promise<ProjectSession> {
    await this.closeProject();
    const s = await ProjectSession.open(target, opts);
    this.attach(s);
    // Regenerate derived files that went missing (e.g. cache cleared).
    for (const a of s.project.assets) if (a.status === "ok") void this.ensureDerived(a.id).catch(() => {});
    return s;
  }

  async closeProject(): Promise<void> {
    if (!this.session) return;
    this.cancelSceneAutoRenders();
    const s = this.session;
    this.session = undefined;
    await s.close();
    this.emit("projectClosed", {});
  }

  // ------------------------------------------------------------ media import

  async importMedia(paths: string[], source: ChangeSource = "user"): Promise<ImportResult> {
    const s = this.requireSession();
    const result: ImportResult = { imported: [], duplicates: [], errors: [] };
    const assets: Asset[] = [];
    for (const raw of paths) {
      const file = path.resolve(raw);
      try {
        const st = await stat(file).catch(() => fail("not_found", "File does not exist"));
        if (!st.isFile()) fail("invalid_params", "Not a regular file");
        const kind = kindFromExtension(file);
        if (!kind) fail("unsupported", `Unsupported file type. Supported: ${SUPPORTED_EXTENSIONS.join(" ")}`);
        const hash = await quickHash(file);
        const dup = [...s.project.assets, ...assets].find((a) => a.hash === hash && a.size === st.size);
        if (dup) {
          result.duplicates.push({ path: file, assetId: dup.id });
          continue;
        }
        let meta: Asset["meta"] = { hasVideo: false, hasAudio: false };
        let finalKind = kind;
        if (kind === "video" || kind === "audio" || kind === "image") {
          const probed = await probeMedia(this.ffprobe, file, kind === "image" ? "image" : undefined);
          meta = probed.meta;
          finalKind = probed.kind;
        }
        const asset = AssetSchema.parse({
          id: newId("ast"),
          kind: finalKind,
          name: path.basename(file),
          path: file,
          relativePath: path.relative(s.dir, file).split(path.sep).join("/"),
          size: st.size,
          hash,
          importedAt: new Date().toISOString(),
          meta,
        });
        assets.push(asset);
      } catch (e) {
        const err = e as { category?: string; message: string };
        result.errors.push({ path: file, category: err.category ?? "io_error", message: err.message });
      }
    }
    if (assets.length) {
      s.transaction(`Import ${assets.length} file${assets.length > 1 ? "s" : ""}`, source, (tx) => {
        for (const a of assets) tx.dispatch("asset.add", { asset: a });
      });
      result.imported = assets;
      for (const a of assets) void this.ensureDerived(a.id).catch(() => {});
    }
    return result;
  }

  /**
   * Render every frame of a 3D scene and encode it to an H.264 file in the
   * project folder (generated/scenes), imported as a video asset: a reusable
   * render for screens inside other scenes (portals) or for fast editing. The
   * file name carries the scene's render key, so an edited scene bakes anew.
   */
  async bakeScene(sceneId: string, opts: { quality?: SceneQuality; scale?: number; source?: ChangeSource } = {}): Promise<Asset> {
    const s = this.requireSession();
    const scene = findScene(s.project, sceneId) ?? fail("not_found", `Scene ${sceneId} not found`);
    const quality = opts.quality ?? "final";
    const scale = opts.scale ?? 1;
    const { key } = this.sceneCacheDir(sceneId, quality, scale);
    const out = path.join(s.dir, "generated", "scenes", `${safeName(scene.name)}-${key}.mp4`);
    if (!(await exists(out))) {
      const r = await this.renderScene(sceneId, { quality, scale });
      const fps = `${s.project.settings.fps.num}/${s.project.settings.fps.den}`;
      const tmp = out.replace(/\.mp4$/, ".partial.mp4");
      await mkdir(path.dirname(out), { recursive: true });
      await runFfmpeg(this.ffmpeg, [
        "-framerate", fps, "-i", path.join(r.dir, "frame_%05d.png"),
        "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "14",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-movflags", "+faststart", tmp,
      ], { timeoutMs: 600_000 });
      await rename(tmp, out);
    }
    const imp = await this.importMedia([out], opts.source ?? "user");
    const id = imp.imported[0]?.id ?? imp.duplicates[0]?.assetId ?? fail("io_error", imp.errors[0]?.message ?? "Baked scene import failed");
    return findAsset(s.project, id)!;
  }

  /**
   * Synthesize a sound effect into the project folder (generated/sfx) and
   * import it. Deterministic: the same parameters reuse the same file/asset.
   */
  async generateSfx(kind: SfxKind, opts: SfxOptions = {}, source: ChangeSource = "user"): Promise<Asset> {
    const s = this.requireSession();
    const file = path.join(s.dir, "generated", "sfx", `${kind}-${sha1(JSON.stringify({ kind, ...opts })).slice(0, 10)}.wav`);
    if (!(await exists(file))) {
      const { left, right } = synthesizeSfx(kind, opts);
      await writeFileAtomic(file, encodeWav(left, right));
    }
    const r = await this.importMedia([file], source);
    const id = r.imported[0]?.id ?? r.duplicates[0]?.assetId ?? fail("io_error", r.errors[0]?.message ?? "Sound effect import failed");
    return findAsset(s.project, id)!;
  }

  /**
   * Compose an original track (see media/music.ts), import it, and record its exact beat grid
   * and sections as the asset's analysis (they are known, not detected). Rendered as a background
   * job; the same options reuse the same file.
   */
  async generateMusic(opts: MusicOptions, source: ChangeSource = "user"): Promise<{ asset: Asset; sections: MusicResult["sections"]; bpm: number }> {
    const s = this.requireSession();
    const key = sha1(JSON.stringify({ v: 1, ...opts })).slice(0, 10);
    const file = path.join(s.dir, "generated", "music", `${opts.style}-${opts.mood}-${key}.wav`);
    const { promise } = this.jobs.submit({ type: "music", label: `Compose ${opts.style} music`, key: `music:${key}` }, async (ctx) => {
      const r = generateMusic(opts);
      ctx.progress(0.9);
      if (!(await exists(file))) await writeFileAtomic(file, encodeWav(r.left, r.right));
      return r;
    });
    const r = (await promise) as MusicResult;
    const imp = await this.importMedia([file], source);
    const id = imp.imported[0]?.id ?? imp.duplicates[0]?.assetId ?? fail("io_error", imp.errors[0]?.message ?? "Music import failed");
    const a = findAsset(s.project, id)!;
    const beats = {
      bpm: r.bpm,
      times: r.beats,
      strengths: r.beats.map((t, i) => (i % 4 === 0 ? 1 : r.sections.some((x) => x.label === "drop" && t >= x.time && t < x.time + x.bars * (240 / r.bpm)) ? 0.8 : 0.5)),
      downbeats: r.downbeats,
      onsets: [],
      sections: r.sections.map((x) => ({ time: x.time, label: x.label, energy: x.energy })),
      confidence: 1,
      analyzedAt: new Date().toISOString(),
    };
    const tags = [...new Set([...a.tags, "generated", "music", opts.style, opts.mood, `${r.bpm} bpm`])];
    s.applySystem("asset.update", { assetId: id, patch: { analysis: { ...a.analysis, beats }, tags } });
    return { asset: findAsset(s.project, id)!, sections: r.sections, bpm: r.bpm };
  }

  /**
   * Speak `text` with a TTS provider (default: the first available, local ones first), level it
   * for dialogue and import it. Cached by provider + request, so regenerating unchanged text is free.
   */
  async generateVoice(req: TtsRequest & { provider?: TtsProviderId }, source: ChangeSource = "user"): Promise<{ asset: Asset; provider: TtsProviderId; seconds: number }> {
    const s = this.requireSession();
    const text = req.text.trim();
    if (!text) fail("invalid_params", "Nothing to say: the text is empty");
    const provider = req.provider
      ? (ttsProviders(this.ffmpeg).find((p) => p.id === req.provider) ?? fail("invalid_params", `Unknown voice provider ${req.provider}`))
      : ((await defaultTtsProvider(this.ffmpeg)) ?? fail("dependency_unavailable", "No text-to-speech engine is available (install espeak-ng, use Windows voices, or set OPENAI_API_KEY / ELEVENLABS_API_KEY)"));
    const st = await provider.status();
    if (!st.available) fail("dependency_unavailable", `${provider.label} is unavailable: ${st.reason}`);
    const request = { text, voice: req.voice, rate: req.rate, pitch: req.pitch, style: req.style };
    const key = sha1(JSON.stringify({ v: 1, p: provider.id, ...request })).slice(0, 12);
    const file = path.join(s.dir, "generated", "voice", `voice-${provider.id}-${key}.wav`);
    if (!(await exists(file))) {
      const { promise } = this.jobs.submit({ type: "voice", label: `Voice: ${text.slice(0, 40)}`, key: `voice:${key}` }, async (ctx) => {
        await mkdir(path.dirname(file), { recursive: true });
        const raw = file.replace(/\.wav$/, ".raw.wav");
        try {
          await provider.synthesize(request, raw, ctx.signal);
          ctx.progress(0.7);
          await finishSpeech(this.ffmpeg, raw, file.replace(/\.wav$/, ".partial.wav"), ctx.signal);
          await rename(file.replace(/\.wav$/, ".partial.wav"), file);
        } finally {
          await rm(raw, { force: true }).catch(() => {});
        }
      });
      await promise;
    }
    const imp = await this.importMedia([file], source);
    const id = imp.imported[0]?.id ?? imp.duplicates[0]?.assetId ?? fail("io_error", imp.errors[0]?.message ?? "Voice import failed");
    const a = findAsset(s.project, id)!;
    const tags = [...new Set([...a.tags, "generated", "voice", `tts:${provider.id}`, ...(req.voice ? [req.voice] : [])])];
    s.applySystem("asset.update", { assetId: id, patch: { tags } });
    return { asset: findAsset(s.project, id)!, provider: provider.id, seconds: a.meta.duration ?? 0 };
  }

  /** Generate missing thumbnails, waveforms, filmstrips and proxies as background jobs. */
  async ensureDerived(assetId: string): Promise<void> {
    const s = this.requireSession();
    const a = findAsset(s.project, assetId);
    if (!a || a.status !== "ok") return;
    const has = async (rel?: string) => !!rel && (await exists(s.resolveInProject(rel)));
    const tasks: Promise<unknown>[] = [];
    const update = (patch: Partial<Asset["derived"]>) => {
      const cur = findAsset(this.requireSession().project, assetId);
      if (cur) this.requireSession().applySystem("asset.update", { assetId, patch: { derived: { ...cur.derived, ...patch } } });
    };
    if ((a.kind === "video" || a.kind === "image") && !(await has(a.derived.thumbnail))) {
      const out = s.cacheDir("thumbs", `${a.id}.jpg`);
      tasks.push(
        this.jobs.submit({ type: "thumbnail", label: `Thumbnail: ${a.name}`, key: `thumb:${a.id}` }, async (ctx) => {
          await makeThumbnail(this.ffmpeg, a, out, ctx.signal);
          update({ thumbnail: s.toProjectRelative(out) });
        }).promise,
      );
    }
    if (a.kind === "video" && !(await has(a.derived.filmstrip))) {
      const out = s.cacheDir("thumbs", `${a.id}.strip.jpg`);
      tasks.push(
        this.jobs.submit({ type: "filmstrip", label: `Filmstrip: ${a.name}`, key: `strip:${a.id}` }, async (ctx) => {
          await makeFilmstrip(this.ffmpeg, a, out, ctx.signal);
          update({ filmstrip: s.toProjectRelative(out) });
        }).promise,
      );
    }
    if (a.meta.hasAudio && !(await has(a.derived.waveform))) {
      const out = s.cacheDir("waveforms", `${a.id}.json`);
      tasks.push(
        this.jobs.submit({ type: "waveform", label: `Waveform: ${a.name}`, key: `wave:${a.id}` }, async (ctx) => {
          await analyzeAudio(this.ffmpeg, a, { beats: false, waveformOut: out, signal: ctx.signal, onProgress: (f) => ctx.progress(f) });
          update({ waveform: s.toProjectRelative(out) });
        }).promise,
      );
    }
    if (a.kind === "video" && !(await has(a.derived.proxy))) {
      const out = s.cacheDir("proxies", `${a.id}.mp4`);
      tasks.push(
        this.jobs.submit({ type: "proxy", label: `Proxy: ${a.name}`, key: `proxy:${a.id}` }, async (ctx) => {
          await makeProxy(this.ffmpeg, a, out, (f) => ctx.progress(f), ctx.signal);
          update({ proxy: s.toProjectRelative(out) });
          ctx.addOutput(out);
        }).promise,
      );
    }
    await Promise.allSettled(tasks);
  }

  async relinkAsset(assetId: string, newPath: string, source: ChangeSource = "user"): Promise<Asset> {
    const s = this.requireSession();
    const a = findAsset(s.project, assetId) ?? fail("not_found", `Asset ${assetId} not found`);
    const file = path.resolve(newPath);
    if (!(await exists(file))) fail("not_found", `File not found: ${file}`);
    const st = await stat(file);
    const patch: Partial<Asset> = { path: file, relativePath: path.relative(s.dir, file).split(path.sep).join("/"), status: "ok", size: st.size, hash: await quickHash(file) };
    if (a.kind === "video" || a.kind === "audio" || a.kind === "image") {
      const probed = await probeMedia(this.ffprobe, file, a.kind === "image" ? "image" : undefined);
      if (probed.kind !== a.kind) fail("invalid_params", `Replacement is a ${probed.kind} file, expected ${a.kind}`);
      patch.meta = probed.meta;
    }
    s.dispatch("asset.update", { assetId, patch: { ...patch, derived: {} } }, source, `Relink ${a.name}`);
    void this.ensureDerived(assetId);
    return findAsset(s.project, assetId)!;
  }

  // ------------------------------------------------------------ audio analysis

  /**
   * Detect tempo/beats/transients. With applyMarkers, beat markers are placed
   * on the timeline where the asset is used (first clip on a music track, or
   * frame 0 if unused).
   */
  async analyzeBeats(assetId: string, opts: { applyMarkers?: boolean; source?: ChangeSource } = {}): Promise<{ analysis: BeatAnalysis; markers?: { beats: number; onsets: number; sections: number }; job: JobInfo }> {
    const s = this.requireSession();
    const a = findAsset(s.project, assetId) ?? fail("not_found", `Asset ${assetId} not found`);
    if (!a.meta.hasAudio) fail("invalid_params", `${a.name} has no audio`);
    const { job, promise } = this.jobs.submit({ type: "beats", label: `Beat analysis: ${a.name}`, key: `beats:${a.id}` }, async (ctx) => {
      const r = await analyzeAudio(this.ffmpeg, a, { beats: true, signal: ctx.signal, onProgress: (f) => ctx.progress(f * 0.9) });
      return toBeatAnalysis(r.beats!);
    });
    const analysis = (await promise) as BeatAnalysis;
    s.applySystem("asset.update", { assetId, patch: { analysis: { ...findAsset(s.project, assetId)!.analysis, beats: analysis } } });
    let markers: { beats: number; onsets: number; sections: number } | undefined;
    if (opts.applyMarkers !== false) markers = this.applyBeatMarkers(assetId, opts.source ?? "user");
    return { analysis, markers, job: this.jobs.get(job.id)! };
  }

  /** Convert an asset's analysed beats to timeline beat markers. */
  applyBeatMarkers(assetId: string, source: ChangeSource): { beats: number; onsets: number; sections: number } {
    const s = this.requireSession();
    const p = s.project;
    const a = findAsset(p, assetId) ?? fail("not_found", `Asset ${assetId} not found`);
    const beats = a.analysis.beats ?? fail("invalid_params", "Asset has not been analysed yet");
    const fps = p.settings.fps;
    // Where is this audio on the timeline?
    let clip: { start: number; sourceIn: number; speed: number; duration: number } | undefined;
    const tracks = [...p.tracks].sort((x, y) => Number(y.role === "music") - Number(x.role === "music"));
    for (const t of tracks) {
      const c = t.clips.find((c) => c.type === "media" && c.assetId === assetId);
      if (c && c.type === "media") {
        clip = c;
        break;
      }
    }
    const map = (sec: number): number | undefined => {
      if (!clip) return secondsToFrames(sec, fps);
      const rel = (sec - clip.sourceIn) / clip.speed;
      if (rel < 0) return undefined;
      const f = clip.start + secondsToFrames(rel, fps);
      return f < clip.start + clip.duration ? f : undefined;
    };
    const down = new Set(beats.downbeats.map((t) => t.toFixed(3)));
    const beatMarkers: { frame: number; strength?: number; downbeat?: boolean }[] = [];
    beats.times.forEach((t, i) => {
      const f = map(t);
      if (f !== undefined) beatMarkers.push({ frame: f, strength: beats.strengths[i], downbeat: down.has(t.toFixed(3)) });
    });
    const onsets = beats.onsets.map(map).filter((f): f is number => f !== undefined);
    // Section starts (the first one is the start of the audio itself: skipped).
    const sections = beats.sections.slice(1).flatMap((x) => {
      const f = map(x.time);
      return f === undefined ? [] : [{ frame: f, label: x.label, energy: x.energy }];
    });
    return s.dispatch("marker.setBeats", { beats: beatMarkers, onsets, sections }, source, `Beat markers (${beats.bpm} BPM)`);
  }

  // ------------------------------------------------------------ rendering helpers

  private mediaPathFor(useProxies: boolean) {
    const s = this.requireSession();
    return (asset: Asset): string => {
      if (useProxies && asset.kind === "video" && asset.derived.proxy) {
        const p = s.resolveInProject(asset.derived.proxy);
        return p;
      }
      return asset.path;
    };
  }

  private fontFor = (clip: TextClip): string | undefined => {
    const s = clip.style;
    if (s.fontAssetId) {
      const a = findAsset(this.project, s.fontAssetId);
      if (a?.status === "ok") return a.path;
    }
    const key = `${s.fontFamily}|${s.bold}`;
    if (this.fontCache.has(key)) return this.fontCache.get(key) ?? this.defaultFont;
    void resolveFontFile(s.fontFamily, s.bold).then((f) => this.fontCache.set(key, f));
    return this.defaultFont;
  };

  async warmFonts(p: Project): Promise<void> {
    for (const t of p.tracks)
      for (const c of t.clips)
        if (c.type === "text") {
          const key = `${c.style.fontFamily}|${c.style.bold}`;
          if (!this.fontCache.has(key)) this.fontCache.set(key, await resolveFontFile(c.style.fontFamily, c.style.bold));
        }
  }

  sceneCacheDir(sceneId: string, quality: SceneQuality, scale: number): { dir: string; key: string } {
    const s = this.requireSession();
    const scene = findScene(s.project, sceneId) ?? fail("not_found", `Scene ${sceneId} not found`);
    const key = sceneRenderKey({ project: s.project, scene, quality, resolutionScale: scale, defaultFont: this.default3dFont });
    return { dir: s.cacheDir("scenes", sceneId, key), key };
  }

  /** Render (or reuse cached) frames of a scene. Frames are 1-based scene frames. */
  async renderScene(sceneId: string, opts: { quality: SceneQuality; scale: number; frames?: number[]; signal?: AbortSignal; ctx?: JobContext }): Promise<{ dir: string; rendered: number; skipped: number; warnings: string[] }> {
    const s = this.requireSession();
    const scene = findScene(s.project, sceneId) ?? fail("not_found", `Scene ${sceneId} not found`);
    const { dir } = this.sceneCacheDir(sceneId, opts.quality, opts.scale);
    const frames = opts.frames ?? Array.from({ length: scene.durationFrames }, (_, i) => i + 1);
    const project = s.project;
    const run = (ctx: JobContext) =>
      renderSceneFrames(
        { project, scene, quality: opts.quality, resolutionScale: opts.scale, defaultFont: this.default3dFont },
        {
          blender: this.blender,
          outputDir: dir,
          frames,
          saveBlend: opts.quality === "final" ? path.join(s.dir, "scenes", `${safeName(scene.name)}.blend`) : undefined,
          signal: ctx.signal,
          onProgress: (done, total) => ctx.progress(done / total, `Frame ${done}/${total}`),
        },
      ).then((r) => this.noteCyclesDevice(r));
    if (opts.ctx) return { dir, ...(await run(opts.ctx)) };
    const { promise } = this.jobs.submit(
      { type: "scene", label: `3D render: ${scene.name} (${opts.quality})`, key: `scene:${dir}:${frames[0]}-${frames[frames.length - 1]}`, lane: "heavy" },
      run,
    );
    return { dir, ...(await promise) };
  }

  /** Remember which compute device Cycles used (shown in the UI status bar). */
  private noteCyclesDevice<R extends { cyclesDevice?: string }>(r: R): R {
    if (r.cyclesDevice && this.deps.blender && this.deps.blender.cyclesDevice !== r.cyclesDevice) {
      this.deps.blender.cyclesDevice = r.cyclesDevice;
      this.emit("deps", this.deps);
    }
    return r;
  }

  // ------------------------------------------------------------ automatic 3D previews

  /** Debounced: after edits settle, keep draft frames of timeline scenes up to date. */
  scheduleSceneAutoRender(): void {
    if (this.sceneAutoTimer) clearTimeout(this.sceneAutoTimer);
    if (!this.config.settings.autoRenderScenes || !this.deps.blender || !this.session) return;
    this.sceneAutoTimer = setTimeout(() => void this.runSceneAutoRender().catch(() => {}), this.sceneAutoDelayMs);
  }

  cancelSceneAutoRenders(): void {
    if (this.sceneAutoTimer) clearTimeout(this.sceneAutoTimer);
    for (const { jobId } of this.sceneAutoJobs.values()) this.jobs.cancel(jobId);
    this.sceneAutoJobs.clear();
  }

  /** Queue draft renders for scenes on the timeline whose cached frames are stale or incomplete. */
  async runSceneAutoRender(): Promise<JobInfo[]> {
    const s = this.session;
    if (!s || !this.deps.blender) return [];
    const p = s.project;
    const scale = this.config.settings.previewScale;
    const used = new Set(p.tracks.flatMap((t) => t.clips).filter((c) => c.type === "scene").map((c) => (c as { sceneId: string }).sceneId));
    // Drop jobs for scenes no longer on the timeline.
    for (const [sceneId, j] of this.sceneAutoJobs) if (!used.has(sceneId)) (this.jobs.cancel(j.jobId), this.sceneAutoJobs.delete(sceneId));
    const queued: JobInfo[] = [];
    for (const sceneId of used) {
      const scene = findScene(p, sceneId);
      if (!scene) continue;
      const { dir } = this.sceneCacheDir(sceneId, "draft", scale);
      const prev = this.sceneAutoJobs.get(sceneId);
      if (prev && prev.dir === dir) {
        const st = this.jobs.get(prev.jobId)?.status;
        if (st === "queued" || st === "running") continue; // already rendering this exact version
      }
      if (prev) this.jobs.cancel(prev.jobId); // superseded by a newer edit
      if ((await existingFrames(dir)).size >= scene.durationFrames) {
        this.sceneAutoJobs.delete(sceneId);
        continue;
      }
      const frames = Array.from({ length: scene.durationFrames }, (_, i) => i + 1);
      const { job, promise } = this.jobs.submit(
        { type: "scene", label: `Auto 3D preview: ${scene.name}`, key: `scene:${dir}:auto`, lane: "heavy" },
        (ctx) =>
          renderSceneFrames(
            { project: p, scene, quality: "draft", resolutionScale: scale, defaultFont: this.default3dFont },
            { blender: this.blender, outputDir: dir, frames, signal: ctx.signal, onProgress: (done, total) => ctx.progress(done / total, `Frame ${done}/${total}`) },
          ).then((r) => this.noteCyclesDevice(r)),
      );
      promise.catch(() => {});
      this.sceneAutoJobs.set(sceneId, { jobId: job.id, dir });
      queued.push(job);
    }
    return queued;
  }

  /** Scene frames needed by a plan, grouped per scene. */
  private sceneFramesNeeded(plan: CompositionPlan): Map<string, number[]> {
    const fps = plan.fps;
    const need = new Map<string, number[]>();
    for (const l of plan.layers) {
      if (l.clip.type !== "scene") continue;
      const scene = findScene(this.project, l.clip.sceneId);
      if (!scene) continue;
      const first = 1 + Math.round(l.sourceStart * fps);
      const list = need.get(scene.id) ?? [];
      for (let j = 0; j < l.frames; j++) {
        const f = first + j;
        if (f > scene.durationFrames) break;
        list.push(f);
      }
      need.set(scene.id, list);
    }
    return need;
  }

  private async prepareScenes(plan: CompositionPlan, quality: SceneQuality, scale: number, ctx: JobContext, weight: number): Promise<Map<string, string>> {
    const dirs = new Map<string, string>();
    const need = this.sceneFramesNeeded(plan);
    let i = 0;
    for (const [sceneId, frames] of need) {
      const r = await this.renderScene(sceneId, {
        quality,
        scale,
        frames,
        ctx: {
          signal: ctx.signal,
          addOutput: ctx.addOutput,
          progress: (f, m) => ctx.progress(((i + (f ?? 0)) / need.size) * weight, m),
        },
      });
      dirs.set(sceneId, r.dir);
      i++;
    }
    return dirs;
  }

  /** Render one frame of the timeline to PNG (cached by content). */
  async renderStill(frame: number, opts: { scale?: number; quality?: SceneQuality } = {}): Promise<{ path: string; cached: boolean; frame: number; warnings: string[] }> {
    const s = this.requireSession();
    const p = s.project;
    const scale = opts.scale ?? this.config.settings.previewScale;
    const quality = opts.quality ?? "draft";
    const f = Math.max(0, Math.min(frame, projectDuration(p) - 1));
    const plan = buildCompositionPlan(p, { rangeStart: f, rangeEnd: f + 1, audio: false });
    const key = this.planKey(plan, { scale, quality, kind: "still" });
    const out = s.cacheDir("previews", `still-${key}.png`);
    if (await exists(out)) return { path: out, cached: true, frame: f, warnings: plan.warnings };
    await this.warmFonts(p);
    const { promise } = this.jobs.submit({ type: "preview", label: `Preview frame ${f}`, key: `still:${key}`, lane: "heavy" }, async (ctx) => {
      const dirs = await this.prepareScenes(plan, quality, scale, ctx, 0.8);
      await compose({
        ffmpeg: this.ffmpeg,
        project: p,
        plan,
        scale,
        output: "still",
        outPath: out,
        workRoot: s.cacheDir("tmp"),
        mediaPath: this.mediaPathFor(scale <= 0.5),
        sceneFrames: (id) => (dirs.has(id) ? { dir: dirs.get(id)! } : undefined),
        fontFile: this.fontFor,
        signal: ctx.signal,
      });
      ctx.addOutput(out);
    });
    await promise;
    return { path: out, cached: false, frame: f, warnings: plan.warnings };
  }

  /** Render a timeline range to a draft MP4 for playback (cached by content). */
  async renderPreviewRange(start: number, end: number, opts: { scale?: number } = {}): Promise<{ path: string; cached: boolean; job?: JobInfo; warnings: string[] }> {
    const s = this.requireSession();
    const p = s.project;
    const scale = opts.scale ?? this.config.settings.previewScale;
    const total = projectDuration(p);
    const rs = Math.max(0, Math.min(start, total - 1));
    const re = Math.max(rs + 1, Math.min(end, total));
    const plan = buildCompositionPlan(p, { rangeStart: rs, rangeEnd: re });
    const key = this.planKey(plan, { scale, quality: "draft", kind: "range" });
    const out = s.cacheDir("previews", `range-${key}.mp4`);
    if (await exists(out)) return { path: out, cached: true, warnings: plan.warnings };
    await this.warmFonts(p);
    const { job, promise } = this.jobs.submit({ type: "preview", label: `Preview render ${rs}-${re}`, key: `range:${key}`, lane: "heavy" }, async (ctx) => {
      const dirs = await this.prepareScenes(plan, "draft", scale, ctx, 0.5);
      await compose({
        ffmpeg: this.ffmpeg,
        project: p,
        plan,
        scale,
        output: "video",
        outPath: out,
        workRoot: s.cacheDir("tmp"),
        mediaPath: this.mediaPathFor(scale <= 0.5),
        sceneFrames: (id) => (dirs.has(id) ? { dir: dirs.get(id)! } : undefined),
        fontFile: this.fontFor,
        draft: true,
        signal: ctx.signal,
        onProgress: (f) => ctx.progress((dirs.size ? 0.5 : 0) + f * (dirs.size ? 0.5 : 1)),
      });
      ctx.addOutput(out);
    });
    await promise;
    return { path: out, cached: false, job: this.jobs.get(job.id), warnings: plan.warnings };
  }

  private planKey(plan: CompositionPlan, extra: Record<string, unknown>): string {
    const p = this.project;
    const assets = new Set<string>();
    for (const l of plan.layers) if (l.clip.type === "media") assets.add(l.clip.assetId);
    for (const a of plan.audio) assets.add(a.assetId);
    const assetSig = [...assets].map((id) => {
      const a = findAsset(p, id);
      return a ? `${a.id}:${a.hash}:${a.derived.proxy ?? ""}` : id;
    });
    const scenes = plan.sceneIds.map((id) => {
      const sc = findScene(p, id);
      // Includes the 3D font: a different default font renders different pixels.
      return sc ? sceneRenderKey({ project: p, scene: sc, quality: "draft", resolutionScale: 0, defaultFont: this.default3dFont }) : id;
    });
    // Beat-driven motion effects read the timeline markers.
    const markers = plan.layers.some((l) => l.clip.effects.some((e) => e.enabled && e.type === "beatPulse")) ? p.markers.map((m) => [m.frame, m.kind]) : undefined;
    return sha1(JSON.stringify({ renderer: RENDERER_VERSION, plan: { ...plan, warnings: undefined }, assetSig, scenes, settings: p.settings, markers, ...extra })).slice(0, 20);
  }

  // ------------------------------------------------------------ export

  /** Pre-flight checks before a final render. */
  validateRender(opts: { preset?: string } = {}): { ok: boolean; issues: ValidationIssue[]; estimate: { frames: number; seconds: number; sceneFrames: number } } {
    const p = this.project;
    const issues = validateProject(p);
    const plan = buildCompositionPlan(p);
    for (const w of plan.warnings) issues.push({ severity: "warning", code: "plan", message: w });
    if (!this.deps.ffmpeg) issues.push({ severity: "error", code: "dependency", message: "FFmpeg is not available" });
    if (plan.sceneIds.length && !this.deps.blender) issues.push({ severity: "error", code: "dependency", message: "Blender is required to render the 3D scenes on the timeline" });
    const preset = EXPORT_PRESET_SIZES[opts.preset ?? p.export.preset];
    if (preset && preset.width) {
      const a1 = preset.width / preset.height;
      const a2 = p.settings.width / p.settings.height;
      if (Math.abs(a1 - a2) > 0.01) issues.push({ severity: "error", code: "aspect", message: `Export preset ${opts.preset ?? p.export.preset} (${preset.width}x${preset.height}) does not match the project aspect ${p.settings.width}x${p.settings.height}` });
    }
    if (plan.layers.length === 0) issues.push({ severity: "error", code: "empty", message: "The timeline has no visible clips" });
    let sceneFrames = 0;
    for (const f of this.sceneFramesNeeded(plan).values()) sceneFrames += f.length;
    const frames = plan.rangeEnd - plan.rangeStart;
    return { ok: !issues.some((i) => i.severity === "error"), issues, estimate: { frames, seconds: frames / plan.fps, sceneFrames } };
  }

  /** Start a final export job. Resolves with the verified output. */
  startExport(opts: { outPath?: string; preset?: string; range?: { start: number; end: number } } = {}): { job: JobInfo; promise: Promise<ExportResult> } {
    const s = this.requireSession();
    const p = s.project;
    const check = this.validateRender({ preset: opts.preset });
    if (!check.ok) fail("invalid_params", `Cannot export: ${check.issues.filter((i) => i.severity === "error").map((i) => i.message).join("; ")}`, check.issues);
    const presetName = opts.preset ?? p.export.preset;
    const preset = EXPORT_PRESET_SIZES[presetName] ?? { width: 0, height: 0 };
    const codec = preset.codec ?? p.export.codec;
    const width = preset.width || p.settings.width;
    const scale = width / p.settings.width;
    const ext = codec === "prores" ? ".mov" : ".mp4";
    const outPath = opts.outPath ? path.resolve(opts.outPath) : path.join(s.dir, "exports", `${safeName(p.name)}_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}${ext}`);
    if (path.extname(outPath).toLowerCase() !== ext) fail("invalid_params", `Output must be ${ext} for ${codec}`);
    const plan = buildCompositionPlan(p, opts.range ? { rangeStart: opts.range.start, rangeEnd: opts.range.end } : {});
    // Background previews must not delay delivery.
    this.cancelSceneAutoRenders();
    return this.jobs.submit({ type: "export", label: `Export ${path.basename(outPath)}`, key: `export:${outPath}`, lane: "heavy" }, async (ctx) => {
      await this.warmFonts(p);
      const sceneWeight = plan.sceneIds.length ? 0.6 : 0;
      ctx.progress(0, plan.sceneIds.length ? "Rendering 3D scenes" : "Composing");
      const dirs = await this.prepareScenes(plan, "final", scale, ctx, sceneWeight);
      ctx.progress(sceneWeight, "Composing and encoding");
      const r = await compose({
        ffmpeg: this.ffmpeg,
        project: p,
        plan,
        scale,
        output: "video",
        outPath,
        workRoot: s.cacheDir("tmp"),
        mediaPath: this.mediaPathFor(false),
        sceneFrames: (id) => (dirs.has(id) ? { dir: dirs.get(id)! } : undefined),
        fontFile: this.fontFor,
        encoding: { ...p.export, codec },
        loudnessLufs: p.export.loudnessLufs,
        signal: ctx.signal,
        onProgress: (f) => ctx.progress(sceneWeight + f * (0.97 - sceneWeight), "Composing and encoding"),
      });
      ctx.progress(0.98, "Verifying output");
      const verified = await verifyOutput(this.ffprobe, this.ffmpeg, outPath, { width: r.width, height: r.height, durationSec: r.durationSec, audio: true });
      if (!verified.ok) fail("render_failed", `Export verification failed: ${verified.problems.join("; ")}`, verified);
      ctx.addOutput(outPath);
      return { outPath, check: verified, warnings: plan.warnings, durationSec: r.durationSec } satisfies ExportResult;
    });
  }

  fps(): number {
    return fpsValue(this.project.settings.fps);
  }
}
