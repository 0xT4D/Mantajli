import {
  buildCompositionPlan,
  evalLayer,
  findAsset,
  fpsValue,
  glitchAt,
  letterboxBar,
  layerCurves,
  MASK_FEATHER,
  revealLines,
  TEXT_LINE_HEIGHT,
  textReveal,
  transitionMask,
  type Asset,
  type BlendMode,
  type Clip,
  type Project,
  type VisualLayer,
} from "@mantagli/core";
import { engine } from "../engine/client";

/**
 * Real-time approximate compositor for playback and scrubbing.
 *
 * Uses the same composition plan and animation curves as the FFmpeg export,
 * so timing, layering, transforms, opacity, fades and transitions match.
 * Colour effects are approximated with canvas filters; effects without a
 * cheap equivalent (glow, LUTs, split tone...) only appear in rendered
 * previews. The viewer labels this mode "Live (approx.)".
 */

type MediaEl = HTMLVideoElement | HTMLAudioElement;

export class LiveCompositor {
  private videos = new Map<string, HTMLVideoElement>();
  private audios = new Map<string, MediaEl>();
  private images = new Map<string, HTMLImageElement>();
  private sceneFrames = new Map<string, HTMLImageElement>();
  private playing = false;
  /** Called when an async source (seek/image load) becomes ready. */
  onNeedsRedraw?: () => void;
  sceneDirs = new Map<string, string>();

  constructor(private dir: () => string | undefined) {}

  private mediaUrl(a: Asset, preferProxy: boolean): string | undefined {
    const d = this.dir();
    const p = preferProxy && a.derived.proxy && d ? `${d}/${a.derived.proxy}` : a.path;
    return engine.fileUrl(p);
  }

  private video(clip: Clip & { type: "media" }, asset: Asset): HTMLVideoElement {
    let v = this.videos.get(clip.id);
    const url = this.mediaUrl(asset, true)!;
    if (!v || v.dataset.src !== url) {
      v?.pause();
      v = document.createElement("video");
      v.crossOrigin = "anonymous";
      v.preload = "auto";
      v.muted = true; // audio is played by separate elements per audio segment
      v.playsInline = true;
      v.src = url;
      v.dataset.src = url;
      v.addEventListener("seeked", () => this.onNeedsRedraw?.());
      v.addEventListener("loadeddata", () => this.onNeedsRedraw?.());
      this.videos.set(clip.id, v);
    }
    return v;
  }

  private image(url: string, cache = this.images): HTMLImageElement {
    let img = cache.get(url);
    if (!img) {
      img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => this.onNeedsRedraw?.();
      img.src = url;
      cache.set(url, img);
    }
    return img;
  }

  /** Draw the frame. When `playing`, media elements free-run and are drift-corrected. */
  draw(ctx: CanvasRenderingContext2D, project: Project, frame: number, playing: boolean): { sceneMissing: boolean } {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const fps = fpsValue(project.settings.fps);
    const k = W / project.settings.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.fillStyle = project.settings.background;
    ctx.fillRect(0, 0, W, H);
    const plan = buildCompositionPlan(project, { rangeStart: frame, rangeEnd: frame + 1 });
    const activeVideo = new Set<string>();
    let sceneMissing = false;

    for (const layer of plan.layers) {
      const clip = layer.clip;
      const clipFrame = layer.clipOffset;
      const curves = layerCurves(clip, { width: W, height: H, hasOutgoing: layer.hasOutgoing, fps, markers: project.markers });
      const st = evalLayer(curves, clipFrame);
      // Keyframed x/y are in project pixels, the rest of the curves in canvas pixels.
      const base = curves.x[0]!;
      const baseY = curves.y[0]!;
      const kx = evalLayer({ ...curves, x: [base], y: [baseY] }, clipFrame);
      const x = kx.x * k + (st.x - kx.x);
      const y = kx.y * k + (st.y - kx.y);
      if (st.opacity <= 0.001) {
        if (clip.type === "media") activeVideo.add(clip.id);
        drawFrameOverlays(ctx, clip, W, H);
        continue;
      }
      let src: CanvasImageSource | undefined;
      let sw = 0;
      let sh = 0;
      if (clip.type === "media") {
        const asset = findAsset(project, clip.assetId);
        if (!asset) continue;
        if (asset.kind === "image") {
          const img = this.image(engine.fileUrl(asset.path)!);
          if (img.complete && img.naturalWidth) [src, sw, sh] = [img, img.naturalWidth, img.naturalHeight];
        } else {
          const v = this.video(clip, asset);
          activeVideo.add(clip.id);
          this.syncMedia(v, layer, playing);
          if (v.readyState >= 2) [src, sw, sh] = [v, v.videoWidth, v.videoHeight];
        }
      } else if (clip.type === "scene") {
        const dir = this.sceneDirs.get(clip.sceneId);
        const f = 1 + Math.round(layer.sourceStart * fps);
        if (dir) {
          const img = this.image(engine.fileUrl(`${dir}/frame_${String(f).padStart(5, "0")}.png`)!, this.sceneFrames);
          if (img.complete && img.naturalWidth) [src, sw, sh] = [img, img.naturalWidth, img.naturalHeight];
          else if (img.complete) sceneMissing = true;
        } else sceneMissing = true;
        if (!src) {
          drawPlaceholder(ctx, W, H, `3D: ${project.scenes.find((s) => s.id === clip.sceneId)?.name ?? "scene"} — render preview to see it`, st.opacity);
          drawFrameOverlays(ctx, clip, W, H);
          continue;
        }
      }

      // Glitch bursts split R/B channels: draw the layer offscreen, then recombine.
      const split = Math.round(glitchShift(clip, clipFrame) * W);
      const out = ctx;
      if (split) ctx = this.scratch(0, W, H);
      ctx.save();
      if (!split) {
        ctx.globalAlpha = st.opacity;
        ctx.globalCompositeOperation = COMPOSITE_OPS[clip.blendMode];
      }
      ctx.filter = cssFilter(clip, k);
      ctx.translate(W / 2 + x, H / 2 + y);
      if (st.rotation) ctx.rotate((st.rotation * Math.PI) / 180);
      const mask = transitionMask(clip, clipFrame);
      if (clip.type === "color") {
        ctx.scale(st.scale, st.scale);
        if (mask) clipMask(ctx, mask, W, H);
        ctx.fillStyle = clip.fill;
        ctx.fillRect(-W / 2, -H / 2, W, H);
      } else if (clip.type === "text") {
        ctx.scale(st.scale, st.scale);
        if (mask) clipMask(ctx, mask, W, H);
        drawText(ctx, clip, W, H, k, textReveal(clip, clipFrame));
      } else if (src && sw && sh) {
        const cr = clip.transform.crop;
        const cx0 = sw * cr.left;
        const cy0 = sh * cr.top;
        const cw = sw * (1 - cr.left - cr.right);
        const ch = sh * (1 - cr.top - cr.bottom);
        let dw: number;
        let dh: number;
        if (clip.transform.fit === "stretch") [dw, dh] = [W, H];
        else {
          const f = clip.transform.fit === "fill" ? Math.max(W / cw, H / ch) : Math.min(W / cw, H / ch);
          [dw, dh] = [cw * f, ch * f];
        }
        dw *= st.scale;
        dh *= st.scale;
        if (mask) clipMask(ctx, mask, dw, dh);
        if (hasFlip(clip, "horizontal")) ctx.scale(-1, 1);
        if (hasFlip(clip, "vertical")) ctx.scale(1, -1);
        ctx.drawImage(src, cx0, cy0, cw, ch, -dw / 2, -dh / 2, dw, dh);
      }
      ctx.restore();
      if (split) {
        ctx = out;
        const merged = this.channelSplit(W, H, split);
        ctx.save();
        ctx.globalAlpha = st.opacity;
        ctx.globalCompositeOperation = COMPOSITE_OPS[clip.blendMode];
        ctx.drawImage(merged, 0, 0);
        ctx.restore();
      }
      drawFrameOverlays(ctx, clip, W, H);
    }

    // Pause videos that are no longer on screen.
    for (const [id, v] of this.videos) if (!activeVideo.has(id) && !v.paused) v.pause();
    this.syncAudio(project, plan.audio, frame, playing);
    this.playing = playing;
    return { sceneMissing };
  }

  private scratchCanvases: HTMLCanvasElement[] = [];

  /** Cleared offscreen canvas #i of size W×H (reused between frames). */
  private scratch(i: number, W: number, H: number): CanvasRenderingContext2D {
    let c = this.scratchCanvases[i];
    if (!c) this.scratchCanvases[i] = c = document.createElement("canvas");
    if (c.width !== W || c.height !== H) [c.width, c.height] = [W, H];
    const g = c.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.filter = "none";
    g.clearRect(0, 0, W, H);
    return g;
  }

  /**
   * Recombine scratch canvas 0 with red moved by +shift and blue by -shift px
   * (the export's rgbashift rh=shift, bh=-shift): each channel is isolated by
   * multiplying with a pure colour and re-masked with the layer's alpha, then
   * the three are added.
   */
  private channelSplit(W: number, H: number, shift: number): HTMLCanvasElement {
    const layer = this.scratchCanvases[0]!;
    const merged = this.scratch(1, W, H);
    merged.globalCompositeOperation = "lighter";
    for (const [color, dx] of [["#ff0000", shift], ["#00ff00", 0], ["#0000ff", -shift]] as const) {
      const ch = this.scratch(2, W, H);
      ch.drawImage(layer, 0, 0);
      ch.globalCompositeOperation = "multiply";
      ch.fillStyle = color;
      ch.fillRect(0, 0, W, H);
      ch.globalCompositeOperation = "destination-in";
      ch.drawImage(layer, 0, 0);
      merged.drawImage(this.scratchCanvases[2]!, dx, 0);
    }
    return this.scratchCanvases[1]!;
  }

  private syncMedia(el: MediaEl, layer: { sourceStart: number; speed: number }, playing: boolean) {
    const target = layer.sourceStart;
    if (playing) {
      if (el.playbackRate !== layer.speed) el.playbackRate = Math.min(16, Math.max(0.0625, layer.speed));
      if (el.paused) {
        el.currentTime = target;
        void el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - target) > 0.2) el.currentTime = target;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - target) > 0.02 && !el.seeking) el.currentTime = target;
    }
  }

  private syncAudio(project: Project, segments: ReturnType<typeof buildCompositionPlan>["audio"], _frame: number, playing: boolean) {
    const active = new Set<string>();
    if (playing) {
      for (const seg of segments) {
        const asset = findAsset(project, seg.assetId);
        if (!asset) continue;
        active.add(seg.clip.id);
        let el = this.audios.get(seg.clip.id);
        const url = engine.fileUrl(asset.kind === "video" && asset.derived.proxy ? `${this.dir()}/${asset.derived.proxy}` : asset.path)!;
        if (!el || el.dataset.src !== url) {
          el?.pause();
          el = document.createElement("audio");
          el.crossOrigin = "anonymous";
          el.preload = "auto";
          el.src = url;
          el.dataset.src = url;
          this.audios.set(seg.clip.id, el);
        }
        const clip = seg.clip;
        const fps = fpsValue(project.settings.fps);
        const f = seg.clipOffset;
        let gain = Math.pow(10, seg.gainDb / 20);
        if (clip.fadeIn > 0 && f < clip.fadeIn) gain *= f / clip.fadeIn;
        if (clip.fadeOut > 0 && f > clip.duration - clip.fadeOut) gain *= (clip.duration - f) / clip.fadeOut;
        el.volume = Math.max(0, Math.min(1, gain));
        void fps;
        this.syncMedia(el, seg, true);
      }
    }
    for (const [id, el] of this.audios) if (!active.has(id) && !el.paused) el.pause();
  }

  stopAll() {
    for (const v of this.videos.values()) v.pause();
    for (const a of this.audios.values()) a.pause();
  }

  dispose() {
    this.stopAll();
    for (const v of this.videos.values()) v.removeAttribute("src");
    for (const a of this.audios.values()) a.removeAttribute("src");
    this.videos.clear();
    this.audios.clear();
  }
}

/** Canvas equivalents of the export’s blend modes. */
const COMPOSITE_OPS: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  screen: "screen",
  add: "lighter",
  multiply: "multiply",
  overlay: "overlay",
  softLight: "soft-light",
  lighten: "lighten",
  darken: "darken",
  difference: "difference",
};

function hasFlip(clip: Clip, dir: "horizontal" | "vertical"): boolean {
  return clip.effects.some((e) => e.enabled && e.type === "flip" && e.params[dir]);
}

/** Canvas-filter approximation of the clip's colour/blur effects. */
/** Letterbox bars in canvas coordinates (same bar height as the export). */
function drawFrameOverlays(ctx: CanvasRenderingContext2D, clip: Clip, W: number, H: number) {
  for (const fx of clip.effects) {
    if (!fx.enabled || fx.type !== "letterbox") continue;
    const bar = Math.round(letterboxBar(String(fx.params.ratio), W, H) * H);
    if (bar <= 0) continue;
    ctx.save();
    ctx.fillStyle = String(fx.params.color);
    ctx.fillRect(0, 0, W, bar);
    ctx.fillRect(0, H - bar, W, bar);
    ctx.restore();
  }
}

/** Total red/blue split of the clip's active glitch effects at a frame (fraction of width). */
function glitchShift(clip: Clip, frame: number): number {
  return clip.effects.reduce((s, e) => s + (e.enabled && e.type === "glitch" ? glitchAt(e.params, frame).shift : 0), 0);
}

function cssFilter(clip: Clip, k: number): string {
  const parts: string[] = [];
  for (const e of clip.effects) {
    if (!e.enabled) continue;
    const p = e.params as Record<string, number>;
    switch (e.type) {
      case "exposure":
        parts.push(`brightness(${Math.pow(2, p.stops!).toFixed(3)})`);
        break;
      case "basicColor":
        parts.push(`contrast(${p.contrast})`, `saturate(${p.saturation})`, `brightness(${(1 + p.brightness!).toFixed(3)})`);
        break;
      case "blur":
        parts.push(`blur(${((p.radius! * k) / 2).toFixed(1)}px)`);
        break;
      case "temperature":
        if (p.warmth! > 0) parts.push(`sepia(${(p.warmth! * 0.35).toFixed(2)})`);
        break;
      case "curves":
        parts.push("contrast(1.1)");
        break;
    }
  }
  return parts.length ? parts.join(" ") : "none";
}

/**
 * Clip to the visible part of a wipe/iris mask on a w×h layer centred at the
 * origin. The export feathers the edge; here the edge sits mid-feather.
 */
function clipMask(ctx: CanvasRenderingContext2D, m: NonNullable<ReturnType<typeof transitionMask>>, w: number, h: number) {
  const f = w * MASK_FEATHER;
  const p = m.progress;
  ctx.beginPath();
  if (m.shape === "right") ctx.rect(-w / 2, -h / 2, (w + f) * p - f / 2, h);
  else if (m.shape === "left") {
    const e = w - (w + f) * p + f / 2;
    ctx.rect(-w / 2 + e, -h / 2, w - e, h);
  } else if (m.shape === "down") ctx.rect(-w / 2, -h / 2, w, (h + f) * p - f / 2);
  else if (m.shape === "up") {
    const e = h - (h + f) * p + f / 2;
    ctx.rect(-w / 2, -h / 2 + e, w, h - e);
  } else ctx.arc(0, 0, Math.max(0, (Math.hypot(w, h) / 2 + f) * p - f / 2), 0, Math.PI * 2);
  ctx.clip();
}

function drawText(ctx: CanvasRenderingContext2D, clip: Clip & { type: "text" }, W: number, H: number, k: number, visible: number) {
  const s = clip.style;
  const size = s.fontSize * k;
  ctx.font = `${s.bold ? "700" : "400"} ${size}px "${s.fontFamily}", sans-serif`;
  ctx.textBaseline = "middle";
  // Layout uses every line (fixed grid); typewriter only truncates what is drawn.
  const lines = revealLines(clip.text, visible);
  const lh = size * TEXT_LINE_HEIGHT;
  const margin = W * 0.08;
  const total = lh * lines.length;
  ctx.textAlign = s.align;
  const x = s.align === "left" ? -W / 2 + margin : s.align === "right" ? W / 2 - margin : 0;
  const typing = visible < Array.from(clip.text.replace(/\r?\n/g, "")).length;
  lines.forEach((line, i) => {
    if (typing && !line) return; // not typed yet (the export skips these lines too)
    const y = -total / 2 + lh * (i + 0.5);
    if (s.box) {
      const m = ctx.measureText(line);
      const pad = size * 0.35;
      const bx = s.align === "left" ? x : s.align === "right" ? x - m.width : x - m.width / 2;
      ctx.save();
      ctx.globalAlpha *= s.boxOpacity;
      ctx.fillStyle = s.boxColor;
      ctx.fillRect(bx - pad, y - lh / 2 - pad / 2, m.width + pad * 2, lh + pad);
      ctx.restore();
    }
    if (s.shadow) {
      ctx.save();
      ctx.globalAlpha *= 0.6;
      ctx.fillStyle = s.shadowColor;
      ctx.fillText(line, x + 4 * k, y + 4 * k);
      ctx.restore();
    }
    if (s.strokeWidth > 0) {
      ctx.lineWidth = s.strokeWidth * k * 2;
      ctx.strokeStyle = s.strokeColor;
      ctx.lineJoin = "round";
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = s.color;
    ctx.fillText(line, x, y);
  });
  void H;
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, W: number, H: number, label: string, opacity: number) {
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = "#1c1410";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#b0663a";
  ctx.setLineDash([6, 6]);
  ctx.strokeRect(8, 8, W - 16, H - 16);
  ctx.fillStyle = "#e0b090";
  ctx.font = `600 ${Math.max(11, W / 36)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, W / 2, H / 2, W - 40);
  ctx.restore();
}

export type { VisualLayer };
