import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
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
import { renderSceneFrames, sceneRenderKey, type SceneQuality } from "./render/blender.js";
import { compose, verifyOutput, type OutputCheck } from "./render/compose.js";
import { defaultFontFile, resolveFontFile } from "./render/fonts.js";
import { ProjectSession } from "./session.js";
import { exists, quickHash, safeName, sha1 } from "./util/fsx.js";

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
    s.on("change", (c) => this.emit("change", c));
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
  async analyzeBeats(assetId: string, opts: { applyMarkers?: boolean; source?: ChangeSource } = {}): Promise<{ analysis: BeatAnalysis; markers?: { beats: number; onsets: number } ; job: JobInfo }> {
    const s = this.requireSession();
    const a = findAsset(s.project, assetId) ?? fail("not_found", `Asset ${assetId} not found`);
    if (!a.meta.hasAudio) fail("invalid_params", `${a.name} has no audio`);
    const { job, promise } = this.jobs.submit({ type: "beats", label: `Beat analysis: ${a.name}`, key: `beats:${a.id}` }, async (ctx) => {
      const r = await analyzeAudio(this.ffmpeg, a, { beats: true, signal: ctx.signal, onProgress: (f) => ctx.progress(f * 0.9) });
      return toBeatAnalysis(r.beats!);
    });
    const analysis = (await promise) as BeatAnalysis;
    s.applySystem("asset.update", { assetId, patch: { analysis: { ...findAsset(s.project, assetId)!.analysis, beats: analysis } } });
    let markers: { beats: number; onsets: number } | undefined;
    if (opts.applyMarkers !== false) markers = this.applyBeatMarkers(assetId, opts.source ?? "user");
    return { analysis, markers, job: this.jobs.get(job.id)! };
  }

  /** Convert an asset's analysed beats to timeline beat markers. */
  applyBeatMarkers(assetId: string, source: ChangeSource): { beats: number; onsets: number } {
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
    return s.dispatch("marker.setBeats", { beats: beatMarkers, onsets }, source, `Beat markers (${beats.bpm} BPM)`);
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
      );
    if (opts.ctx) return { dir, ...(await run(opts.ctx)) };
    const { promise } = this.jobs.submit(
      { type: "scene", label: `3D render: ${scene.name} (${opts.quality})`, key: `scene:${dir}:${frames[0]}-${frames[frames.length - 1]}`, lane: "heavy" },
      run,
    );
    return { dir, ...(await promise) };
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
      return sc ? sceneRenderKey({ project: p, scene: sc, quality: "draft", resolutionScale: 0 }) : id;
    });
    return sha1(JSON.stringify({ plan: { ...plan, warnings: undefined }, assetSig, scenes, settings: p.settings, ...extra })).slice(0, 20);
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
