import {
  buildCompositionPlan,
  chromaKeyAlpha,
  evalCurve,
  evalLayer,
  findAsset,
  fpsValue,
  glitchAt,
  grainSigma,
  cropsToFrameCell,
  isConstant,
  lensCoefficients,
  lensSource,
  letterboxBar,
  maskGeometry,
  layerCurves,
  MASK_FEATHER,
  TEXT_LINE_HEIGHT,
  textLinesAt,
  transitionFx,
  transitionMask,
  vignetteFactor,
  backdropKey,
  hasBackdrop,
  renderBackdrop,
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
  /** Draft 3D frame caches per scene: folder and the (inclusive) ranges of frames rendered so far. */
  sceneDirs = new Map<string, { dir: string; ranges: [number, number][] }>();

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
      const curveOpts = { width: W, height: H, hasOutgoing: layer.hasOutgoing, fps, markers: project.markers, transitionOut: layer.transitionOut };
      const curves = layerCurves(clip, curveOpts);
      const tfx = transitionFx(clip, clipFrame, curveOpts);
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
      if (clip.type === "adjustment") {
        // Adjustment layer: a copy of everything composited so far is the source.
        this.scratch(4, W, H).drawImage(ctx.canvas, 0, 0);
        [src, sw, sh] = [this.scratchCanvases[4]!, W, H];
      } else if (clip.type === "media") {
        const asset = findAsset(project, clip.assetId);
        if (!asset) continue;
        if (asset.kind === "image") {
          const img = this.image(engine.fileUrl(asset.path)!);
          if (img.complete && img.naturalWidth) [src, sw, sh] = [img, img.naturalWidth, img.naturalHeight];
        } else {
          const v = this.video(clip, asset);
          activeVideo.add(clip.id);
          // Held and reversed frames are stepped by seeking (browsers cannot play backwards).
          this.syncMedia(v, layer, playing && !clip.freeze && !clip.reverse);
          if (v.readyState >= 2) [src, sw, sh] = [v, v.videoWidth, v.videoHeight];
        }
      } else if (clip.type === "scene") {
        const cache = this.sceneDirs.get(clip.sceneId);
        const f = 1 + Math.round(layer.sourceStart * fps);
        // Only frames known to be rendered are requested (a partial cache would otherwise 404 per frame).
        if (cache && cache.ranges.some(([a, b]) => f >= a && f <= b)) {
          const img = this.image(engine.fileUrl(`${cache.dir}/frame_${String(f).padStart(5, "0")}.png`)!, this.sceneFrames);
          if (img.complete && img.naturalWidth) [src, sw, sh] = [img, img.naturalWidth, img.naturalHeight];
          else if (img.complete) sceneMissing = true;
        } else sceneMissing = true;
        if (!src) {
          drawPlaceholder(ctx, W, H, `3D: ${project.scenes.find((s) => s.id === clip.sceneId)?.name ?? "scene"} — render preview to see it`, st.opacity);
          drawFrameOverlays(ctx, clip, W, H);
          continue;
        }
      }

      // Glitch bursts and chromatic aberration (R/B split) and shape masks need the layer drawn offscreen first.
      const split = Math.round((glitchShift(clip, clipFrame) + tfx.rgbShift) * W) - aberrationShift(clip, k);
      const masks = clip.effects.filter((e) => e.enabled && e.type === "mask");
      const stylized = clip.effects.some((e) => e.enabled && STYLIZE_LIVE.has(e.type));
      // Pictures (media, 3D) are stylized in their own fit-scaled space, as the export does;
      // colour, text and adjustment layers are frame-sized there, so the frame is their space.
      const styleInLayer = stylized && (clip.type === "media" || clip.type === "scene");
      const smear = tfx.blurRadius >= 1;
      const offscreen = split !== 0 || masks.length > 0 || (stylized && !styleInLayer) || smear;
      const out = ctx;
      if (offscreen) ctx = this.scratch(0, W, H);
      ctx.save();
      if (!offscreen) {
        ctx.globalAlpha = st.opacity;
        ctx.globalCompositeOperation = COMPOSITE_OPS[clip.blendMode];
      }
      ctx.filter = cssFilter(clip, k, tfx.zoomSigma);
      ctx.translate(W / 2 + x, H / 2 + y);
      if (st.rotation) ctx.rotate((st.rotation * Math.PI) / 180);
      const mask = transitionMask(clip, clipFrame);
      if (clip.type === "color") {
        ctx.scale(st.scale, st.scale);
        if (mask) clipMask(ctx, mask, W, H);
        if (hasBackdrop(clip.backdrop)) ctx.drawImage(this.backdropCanvas(clip.fill, clip.backdrop, W, H), -W / 2, -H / 2, W, H);
        else {
          ctx.fillStyle = clip.fill;
          ctx.fillRect(-W / 2, -H / 2, W, H);
        }
      } else if (clip.type === "text") {
        ctx.scale(st.scale, st.scale);
        if (mask) clipMask(ctx, mask, W, H);
        drawText(ctx, clip, W, H, k, textLinesAt(clip, clipFrame));
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
        // Slides/whips move the framed picture, not a fill-fit source's overflow (as the export).
        const cellCrop = curves.scale.every(isConstant) && cropsToFrameCell(clip, layer.transitionOut);
        if (cellCrop) {
          ctx.beginPath();
          ctx.rect(-W / 2, -H / 2, W, H);
          ctx.clip();
        }
        if (hasFlip(clip, "horizontal")) ctx.scale(-1, 1);
        if (hasFlip(clip, "vertical")) ctx.scale(1, -1);
        const key = clip.effects.find((e) => e.enabled && e.type === "chromaKey");
        let keyedSrc: HTMLCanvasElement | undefined;
        try {
          if (key) keyedSrc = this.keyed(src, cx0, cy0, cw, ch, Math.min(dw, W * 2), Math.min(dh, H * 2), key.params);
        } catch {
          keyedSrc = undefined; // tainted source: show it unkeyed rather than nothing
        }
        if (styleInLayer) {
          // The export crops a frame-cell layer before its effects, so they see only that part.
          const [lw, lh] = cellCrop ? [Math.min(dw, W), Math.min(dh, H)] : [dw, dh];
          const [fx, fy] = [lw / dw, lh / dh];
          const region = keyedSrc
            ? [(keyedSrc.width * (1 - fx)) / 2, (keyedSrc.height * (1 - fy)) / 2, keyedSrc.width * fx, keyedSrc.height * fy]
            : [cx0 + (cw * (1 - fx)) / 2, cy0 + (ch * (1 - fy)) / 2, cw * fx, ch * fy];
          const styled = this.stylizedPicture(keyedSrc ?? src, region, lw, lh, ctx.filter, clip, W, H, k, frame);
          ctx.filter = "none"; // already applied inside the layer
          ctx.drawImage(styled, -lw / 2, -lh / 2, lw, lh);
        } else if (keyedSrc) ctx.drawImage(keyedSrc, -dw / 2, -dh / 2, dw, dh);
        else ctx.drawImage(src, cx0, cy0, cw, ch, -dw / 2, -dh / 2, dw, dh);
      }
      ctx.restore();
      if (offscreen) {
        ctx = out;
        let layerCanvas = split ? this.channelSplit(W, H, split) : this.scratchCanvases[0]!;
        if (smear) layerCanvas = this.smear(layerCanvas, W, H, tfx.blurAngle, tfx.blurRadius);
        if (stylized && !styleInLayer) layerCanvas = this.stylize(layerCanvas, clip, W, H, k, frame);
        if (masks.length) applyMasks(layerCanvas, masks, W, H);
        ctx.save();
        ctx.globalAlpha = st.opacity;
        ctx.globalCompositeOperation = COMPOSITE_OPS[clip.blendMode];
        ctx.drawImage(layerCanvas, 0, 0);
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
    const g = c.getContext("2d", { willReadFrequently: i === 3 || i === 5 })!; // #3 (keying) and #5 (lens) are read back
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

  /**
   * Directional motion blur (approximation of the export's dblur): the running
   * average of copies spread along the blur direction over `radius` px, one
   * every ~3 px (8–32 copies) so long streaks stay smooth instead of stepped.
   */
  private smear(layer: HTMLCanvasElement, W: number, H: number, angleDeg: number, radius: number): HTMLCanvasElement {
    const g = this.scratch(6, W, H);
    const n = Math.max(8, Math.min(32, Math.ceil(radius / 3)));
    const [dx, dy] = [Math.cos((angleDeg * Math.PI) / 180), Math.sin((angleDeg * Math.PI) / 180)];
    for (let i = 0; i < n; i++) {
      const o = (i / (n - 1) - 0.5) * radius;
      g.globalAlpha = 1 / (i + 1);
      g.drawImage(layer, dx * o, dy * o);
    }
    return this.scratchCanvases[6]!;
  }

  private lensMaps = new Map<string, LensMap>();
  private vignettes = new Map<string, HTMLCanvasElement>();

  /**
   * Vignette, scanlines, film grain and lens distortion on a layer canvas with the
   * export's formulas: cos⁴ vignette and scanlines on the same grid (in stack order),
   * then Gaussian grain of the same strength (a different random pattern), then the
   * bilinear lens remap last, as in the export. Grain and lens run on the CPU canvas #5.
   */
  private stylize(layer: HTMLCanvasElement, clip: Clip, W: number, H: number, k: number, frame: number): HTMLCanvasElement {
    const g = layer.getContext("2d")!;
    let grain = 0;
    for (const e of clip.effects) {
      if (!e.enabled) continue;
      const p = e.params as Record<string, number | string>;
      if (e.type === "grain") {
        grain = Math.hypot(grain, grainSigma(Number(p.amount))); // independent noises add in quadrature
        continue;
      }
      g.save();
      g.globalCompositeOperation = "source-atop"; // only where the layer has pixels
      if (e.type === "vignette") {
        g.drawImage(this.vignetteMask(W, H, Number(p.amount)), 0, 0, W, H);
      } else if (e.type === "scanlines" && Number(p.amount) > 0) {
        const sp = Math.max(2, Math.round(Number(p.spacing) * k));
        const t = Math.max(1, Math.floor(sp / 2));
        g.fillStyle = `rgba(0,0,0,${Number(p.amount)})`;
        for (let y = 0; y < H; y += sp) g.fillRect(0, y, W, t);
      }
      g.restore();
    }
    const lens = clip.effects.find((e) => e.enabled && e.type === "lensDistortion" && Number(e.params.amount) !== 0);
    if (!lens && grain <= 0) return layer;
    const out = this.scratch(5, W, H);
    out.drawImage(layer, 0, 0);
    const src = out.getImageData(0, 0, W, H);
    if (grain > 0) addGrain(src.data, grain, frame);
    if (!lens) {
      out.putImageData(src, 0, 0);
      return this.scratchCanvases[5]!;
    }
    const amount = Number(lens.params.amount);
    const key = `${W}x${H}:${amount}`;
    let map = this.lensMaps.get(key);
    if (!map) {
      map = lensMap(W, H, amount);
      if (this.lensMaps.size > 8) this.lensMaps.clear();
      this.lensMaps.set(key, map);
    }
    const dst = out.createImageData(W, H);
    remapBilinear(src.data, dst.data, map, W, lens.params.edges === "transparent" ? 0 : 255);
    out.putImageData(dst, 0, 0);
    return this.scratchCanvases[5]!;
  }

  /**
   * A picture drawn at its layer size (lw × lh canvas px, at most ~6 frames of pixels) with
   * `filter`, then stylized in that space: the export applies vignette, scanlines, grain and
   * lens distortion to the fit-scaled layer, including the overflow a "fill" fit hides.
   */
  private stylizedPicture(src: CanvasImageSource, [sx, sy, sw, sh]: number[], lw: number, lh: number, filter: string, clip: Clip, W: number, H: number, k: number, frame: number): HTMLCanvasElement {
    const r = Math.min(1, Math.sqrt((6 * W * H) / Math.max(1, lw * lh)));
    const w = Math.max(2, Math.round(lw * r));
    const h = Math.max(2, Math.round(lh * r));
    const g = this.scratch(7, w, h);
    g.filter = filter;
    g.drawImage(src, sx!, sy!, sw!, sh!, 0, 0, w, h);
    g.filter = "none";
    return this.stylize(this.scratchCanvases[7]!, clip, w, h, k * r, frame);
  }

  /**
   * Black with alpha 1 − cos⁴ falloff: drawn source-atop over a W×H layer it multiplies the
   * layer by the vignette factor. Made at ≤ 512 px with the layer's aspect (it is smooth) and
   * stretched, so a layer whose size animates does not rebuild it every frame.
   */
  private vignetteMask(W: number, H: number, amount: number): HTMLCanvasElement {
    const mw = Math.max(8, Math.round(W >= H ? 512 : (512 * W) / H));
    const mh = Math.max(8, Math.round(H >= W ? 512 : (512 * H) / W));
    const key = `${mw}x${mh}:${amount}`;
    let c = this.vignettes.get(key);
    if (!c) {
      c = document.createElement("canvas");
      [c.width, c.height] = [mw, mh];
      const g = c.getContext("2d")!;
      const img = g.createImageData(mw, mh);
      for (let y = 0; y < mh; y++)
        for (let x = 0; x < mw; x++) img.data[(y * mw + x) * 4 + 3] = Math.round(255 * (1 - vignetteFactor(x + 0.5, y + 0.5, mw, mh, amount)));
      g.putImageData(img, 0, 0);
      if (this.vignettes.size > 8) this.vignettes.clear();
      this.vignettes.set(key, c);
    }
    return c;
  }

  private backdrops = new Map<string, HTMLCanvasElement>();
  /** Card backdrop from the same core rasterizer as the export (at most 1280 px on the long side, scaled up). */
  private backdropCanvas(fill: string, b: Parameters<typeof renderBackdrop>[1], W: number, H: number): HTMLCanvasElement {
    const f = Math.min(1, 1280 / Math.max(W, H));
    const [bw, bh] = [Math.max(1, Math.round(W * f)), Math.max(1, Math.round(H * f))];
    const key = backdropKey(fill, b, bw, bh);
    let c = this.backdrops.get(key);
    if (!c) {
      c = document.createElement("canvas");
      [c.width, c.height] = [bw, bh];
      c.getContext("2d")!.putImageData(new ImageData(renderBackdrop(fill, b, bw, bh) as Uint8ClampedArray<ArrayBuffer>, bw, bh), 0, 0);
      if (this.backdrops.size > 8) this.backdrops.clear();
      this.backdrops.set(key, c);
    }
    return c;
  }

  /** Source region drawn at w×h with the chroma key applied per pixel (same formula as the export). */
  private keyed(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, w: number, h: number, params: Record<string, unknown>): HTMLCanvasElement {
    const W = Math.max(1, Math.round(w));
    const H = Math.max(1, Math.round(h));
    const g = this.scratch(3, W, H);
    g.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    const hexc = String(params.color);
    const key: [number, number, number] = [parseInt(hexc.slice(1, 3), 16), parseInt(hexc.slice(3, 5), 16), parseInt(hexc.slice(5, 7), 16)];
    const sim = Number(params.similarity);
    const blend = Number(params.blend);
    const greenKey = key[1] >= key[2];
    for (let i = 0; i < d.length; i += 4) {
      const a = chromaKeyAlpha(d[i]!, d[i + 1]!, d[i + 2]!, key, sim, blend);
      d[i + 3] = Math.round(d[i + 3]! * a);
      if (params.despill) {
        // Clamp the key channel to the other two (FFmpeg despill, approximately).
        if (greenKey) d[i + 1] = Math.min(d[i + 1]!, Math.max(d[i]!, d[i + 2]!));
        else d[i + 2] = Math.min(d[i + 2]!, Math.max(d[i]!, d[i + 1]!));
      }
    }
    g.putImageData(img, 0, 0);
    return this.scratchCanvases[3]!;
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
        if (seg.clip.reverse) continue; // reversed audio is exact in renders only
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
        let gain = Math.pow(10, (seg.gainDb + (seg.duck.length ? evalCurve(seg.duck, f) : 0)) / 20);
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

/** Effects the live preview draws in a post pass on the layer canvas (see `stylize`). */
const STYLIZE_LIVE = new Set(["vignette", "scanlines", "grain", "lensDistortion"]);

/**
 * Lens remap table: for each output pixel the top-left source pixel (-1 outside the
 * frame, as FFmpeg `lenscorrection` fills) and 8-bit bilinear weights to its right/lower
 * neighbours. Positions use the export's pixel-index convention (see `lensSource`).
 */
interface LensMap {
  idx: Int32Array;
  fx: Uint8Array;
  fy: Uint8Array;
}

function lensMap(W: number, H: number, amount: number): LensMap {
  const kk = lensCoefficients(amount);
  const idx = new Int32Array(W * H);
  const fx = new Uint8Array(W * H);
  const fy = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const [sx, sy] = lensSource(x, y, W, H, kk);
      if (!(sx >= 0 && sy >= 0 && sx <= W - 1 && sy <= H - 1)) {
        idx[i] = -1;
        continue;
      }
      // Keep the 2×2 footprint inside the frame: the last column/row samples its own pixel at weight 1.
      const x0 = Math.min(Math.floor(sx), W - 2);
      const y0 = Math.min(Math.floor(sy), H - 2);
      idx[i] = y0 * W + x0;
      fx[i] = Math.round((sx - x0) * 255);
      fy[i] = Math.round((sy - y0) * 255);
    }
  return { idx, fx, fy };
}

/** Bilinear lens remap of RGBA pixels; pixels outside the source get black with alpha `fillAlpha`. */
function remapBilinear(src: Uint8ClampedArray, dst: Uint8ClampedArray, map: LensMap, W: number, fillAlpha: number) {
  const { idx, fx, fy } = map;
  for (let i = 0; i < idx.length; i++) {
    const o = i * 4;
    const j = idx[i]!;
    if (j < 0) {
      dst[o + 3] = fillAlpha;
      continue;
    }
    const wx = fx[i]!;
    const wy = fy[i]!;
    const a = j * 4;
    const b = a + 4;
    const c = a + W * 4;
    const d = c + 4;
    for (let ch = 0; ch < 4; ch++) {
      const top = src[a + ch]! * (255 - wx) + src[b + ch]! * wx;
      const bottom = src[c + ch]! * (255 - wx) + src[d + ch]! * wx;
      dst[o + ch] = (top * (255 - wy) + bottom * wy) / 65025;
    }
  }
}

/** Standard-normal samples ×32 (int8), one table for every frame; frames read it at different offsets. */
const GRAIN_TABLE_BITS = 20;
let grainTable: Int8Array | undefined;
function grainNoise(): Int8Array {
  if (grainTable) return grainTable;
  const t = new Int8Array(1 << GRAIN_TABLE_BITS);
  let seed = 0x9e3779b9;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) + 1) / 4294967297;
  for (let i = 0; i < t.length; i += 2) {
    // Box–Muller: two independent normals per pair of uniforms.
    const r = Math.sqrt(-2 * Math.log(rnd()));
    const a = 2 * Math.PI * rnd();
    t[i] = Math.max(-127, Math.min(127, Math.round(32 * r * Math.cos(a))));
    t[i + 1] = Math.max(-127, Math.min(127, Math.round(32 * r * Math.sin(a))));
  }
  return (grainTable = t);
}

/** Temporal film grain on RGBA pixels: independent Gaussian noise (std `sigma` levels) per channel, a new pattern each frame. */
function addGrain(d: Uint8ClampedArray, sigma: number, frame: number) {
  const noise = grainNoise();
  const mask = noise.length - 1;
  const scale = sigma / 32;
  let n = Math.imul(frame + 1, 0x2545f491) >>> 0; // frame-dependent start, so the grain moves
  for (let o = 0; o < d.length; o += 4) {
    if (d[o + 3] === 0) continue;
    for (let ch = 0; ch < 3; ch++) d[o + ch] = d[o + ch]! + noise[n++ & mask]! * scale;
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
/** Cut a layer canvas to its shape masks (frame coordinates); the blur approximates the export's feather. */
function applyMasks(canvas: HTMLCanvasElement, masks: { params: Record<string, unknown> }[], W: number, H: number) {
  const g = canvas.getContext("2d")!;
  for (const m of masks) {
    const geo = maskGeometry(m.params, W, H);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = geo.invert ? "destination-out" : "destination-in";
    g.filter = geo.feather > 1 ? `blur(${(geo.feather / 2.5).toFixed(1)}px)` : "none";
    g.fillStyle = "#000";
    g.beginPath();
    if (geo.ellipse) g.ellipse(geo.cx, geo.cy, geo.hw, geo.hh, 0, 0, Math.PI * 2);
    else g.rect(geo.cx - geo.hw, geo.cy - geo.hh, geo.hw * 2, geo.hh * 2);
    g.fill();
    g.restore();
  }
}

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

/** Red-left / blue-right offset (canvas px) of the clip's chromatic aberration effects. */
function aberrationShift(clip: Clip, k: number): number {
  return clip.effects.reduce((s, e) => s + (e.enabled && e.type === "chromaticAberration" ? Math.round(Number(e.params.pixels) * k) : 0), 0);
}

/** Total red/blue split of the clip's active glitch effects at a frame (fraction of width). */
function glitchShift(clip: Clip, frame: number): number {
  return clip.effects.reduce((s, e) => s + (e.enabled && e.type === "glitch" ? glitchAt(e.params, frame).shift : 0), 0);
}

function cssFilter(clip: Clip, k: number, zoomSigma = 0): string {
  const parts: string[] = [];
  if (zoomSigma >= 0.3) parts.push(`blur(${zoomSigma.toFixed(1)}px)`);
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

function drawText(ctx: CanvasRenderingContext2D, clip: Clip & { type: "text" }, W: number, H: number, k: number, lines: string[]) {
  const s = clip.style;
  const size = s.fontSize * k;
  ctx.font = `${s.bold ? "700" : "400"} ${size}px "${s.fontFamily}", sans-serif`;
  ctx.textBaseline = "middle";
  // Layout uses every line (fixed grid); reveals only change what is drawn.
  const lh = size * TEXT_LINE_HEIGHT;
  const margin = W * 0.08;
  const total = lh * lines.length;
  ctx.textAlign = s.align;
  const x = s.align === "left" ? -W / 2 + margin : s.align === "right" ? W / 2 - margin : 0;
  const animating = lines.join("\n") !== clip.text.replace(/\r\n/g, "\n");
  lines.forEach((line, i) => {
    if (animating && !line) return; // not revealed yet (the export skips these runs too)
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
