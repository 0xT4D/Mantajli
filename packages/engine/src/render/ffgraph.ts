import path from "node:path";
import {
  evalLayer,
  fail,
  findAsset,
  isConstant,
  layerCurves,
  MASK_FEATHER,
  revealLines,
  textReveal,
  transitionMask,
  type Asset,
  type CompositionPlan,
  type Curve,
  type Effect,
  type Project,
  type TextClip,
  type VisualLayer,
  TEXT_LINE_HEIGHT,
} from "@mantagli/core";

/**
 * Builds an FFmpeg filter graph that renders a CompositionPlan.
 *
 * Layering: a background canvas, then every visual layer bottom-up through
 * `overlay`. Each layer: decode → retime → fixed frame count → crop → fit
 * scale → effects → RGBA → rotate → animated scale → opacity → shift to its
 * timeline position. Compositing happens in RGB; the output is converted
 * once to BT.709 at the end so colour stays consistent across sources.
 */

export interface SceneFrames {
  /** Directory of rendered PNG frames named frame_00001.png (1-based). */
  dir: string;
}

export interface GraphContext {
  project: Project;
  plan: CompositionPlan;
  /** Output size multiplier (preview renders use < 1). */
  scale: number;
  /** Absolute media path for an asset (proxy or original). */
  mediaPath(asset: Asset): string;
  sceneFrames(sceneId: string): SceneFrames | undefined;
  fontFile(clip: TextClip): string | undefined;
  /** Files written into the work dir (text, sendcmd scripts). */
  writeFile(name: string, content: string): void;
  includeAudio: boolean;
  output: "video" | "still";
}

export interface BuiltGraph {
  inputs: string[][];
  filter: string;
  videoLabel: string;
  audioLabel?: string;
  frames: number;
  durationSec: number;
  width: number;
  height: number;
}

const n6 = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? "0" : String(r);
};
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** `T + s` written without double signs. */
function plus(T: string, s: number): string {
  if (Math.abs(s) < 1e-9) return T;
  return s > 0 ? `(${T}+${n6(s)})` : `(${T}-${n6(-s)})`;
}

function easeExpr(easing: string, u: string): string {
  switch (easing) {
    case "linear":
      return u;
    case "easeIn":
      return `(${u})*(${u})`;
    case "easeOut":
      return `(1-(1-${u})*(1-${u}))`;
    case "easeInOut":
      return `(${u})*(${u})*(3-2*(${u}))`;
    default:
      return "0";
  }
}

/** Piecewise curve as an FFmpeg expression of T (clip-relative seconds). */
export function curveExpr(c: Curve, T: string, fps: number, mul = 1): string {
  const v = (x: number) => n6(x * mul);
  if (c.length === 1 || isConstant(c)) return v(c[0]!.value);
  let expr = v(c[c.length - 1]!.value);
  for (let i = c.length - 2; i >= 0; i--) {
    const a = c[i]!;
    const b = c[i + 1]!;
    const ta = a.frame / fps;
    const tb = b.frame / fps;
    const u = `((${T}-${n6(ta)})/${n6(Math.max(1e-6, tb - ta))})`;
    const seg = `(${v(a.value)}+(${v(b.value - a.value)})*${easeExpr(a.easing, u)})`;
    expr = `if(lt(${T},${n6(tb)}),${seg},${expr})`;
  }
  const first = c[0]!;
  return `if(lt(${T},${n6(first.frame / fps)}),${v(first.value)},${expr})`;
}

const sumExpr = (cs: Curve[], T: string, fps: number, mul: number) => {
  const parts = cs.filter((c) => !(isConstant(c) && c[0]!.value === 0)).map((c) => curveExpr(c, T, fps, mul));
  return parts.length ? parts.join("+") : "0";
};
const prodExpr = (cs: Curve[], T: string, fps: number) => {
  const parts = cs.filter((c) => !(isConstant(c) && c[0]!.value === 1)).map((c) => `(${curveExpr(c, T, fps)})`);
  return parts.length ? parts.join("*") : "1";
};
const animated = (cs: Curve[]) => cs.some((c) => !isConstant(c));

/** Escape a filesystem path for use as a quoted filter option value. */
export function filterPath(p: string): string {
  if (/['\[\],;]/.test(p)) fail("unsupported", `Path contains characters FFmpeg filters cannot reference: ${p}`);
  return `'${p.replace(/\\/g, "/").replace(/:/g, "\\:")}'`;
}

const hex = (c: string) => `0x${c.replace("#", "")}`;

// ------------------------------------------------------------------ effects

function hueRgb(hueDeg: number, amount: number): [number, number, number] {
  const h = (hueDeg * Math.PI) / 180;
  const k = amount * 0.35;
  return [Math.cos(h) * k, Math.cos(h - (2 * Math.PI) / 3) * k, Math.cos(h - (4 * Math.PI) / 3) * k];
}

/**
 * Append effect filters. Returns graph statements and the output label.
 * Input is assumed opaque; alpha layers are wrapped by the caller.
 */
function effectStatements(effects: Effect[], inLabel: string, id: string, px: number, ctx: GraphContext): { stmts: string[]; out: string } {
  const stmts: string[] = [];
  let cur = inLabel;
  let chain: string[] = [];
  let n = 0;
  const flush = () => {
    if (!chain.length) return;
    const out = `${id}_e${n++}`;
    stmts.push(`[${cur}]${chain.join(",")}[${out}]`);
    cur = out;
    chain = [];
  };
  for (const fx of effects) {
    if (!fx.enabled) continue;
    const p = fx.params as Record<string, number | string | boolean>;
    const num = (k: string) => Number(p[k]);
    switch (fx.type) {
      case "exposure":
        chain.push(`exposure=exposure=${n6(num("stops"))}`);
        break;
      case "basicColor":
        chain.push(`eq=contrast=${n6(num("contrast"))}:saturation=${n6(num("saturation"))}:brightness=${n6(num("brightness"))}:gamma=${n6(num("gamma"))}`);
        break;
      case "temperature": {
        const w = num("warmth");
        const t = num("tint");
        if (w) chain.push(`colortemperature=temperature=${Math.round(6500 * Math.pow(2, -w * 1.1))}:mix=1`);
        if (t) chain.push(`colorbalance=rm=${n6(t * 0.12)}:gm=${n6(-t * 0.12)}:bm=${n6(t * 0.12)}`);
        break;
      }
      case "tone": {
        const sh = num("shadows") * 0.12;
        const hl = num("highlights") * 0.12;
        chain.push(`curves=all='0/0 0.25/${n6(0.25 + sh)} 0.5/0.5 0.75/${n6(0.75 + hl)} 1/1'`);
        break;
      }
      case "splitTone": {
        const [rs, gs, bs] = hueRgb(num("shadowHue"), num("shadowAmount"));
        const [rh, gh, bh] = hueRgb(num("highlightHue"), num("highlightAmount"));
        chain.push(`colorbalance=rs=${n6(rs)}:gs=${n6(gs)}:bs=${n6(bs)}:rh=${n6(rh)}:gh=${n6(gh)}:bh=${n6(bh)}`);
        break;
      }
      case "curves":
        chain.push(`curves=preset=${String(p.preset)}`);
        break;
      case "lut": {
        const a = findAsset(ctx.project, String(p.assetId));
        if (!a || a.status !== "ok") fail("missing_asset", `LUT asset ${String(p.assetId)} is missing`);
        chain.push(`lut3d=file=${filterPath(a.path)}`);
        break;
      }
      case "vignette":
        chain.push(`vignette=angle=${n6(0.15 + num("amount") * 1.0)}`);
        break;
      case "glow": {
        chain.push("format=gbrp");
        flush();
        const a = `${id}_g${n}a`;
        const b = `${id}_g${n}b`;
        const bb = `${id}_g${n}c`;
        const out = `${id}_e${n++}`;
        stmts.push(`[${cur}]split=2[${a}][${b}]`);
        stmts.push(`[${b}]gblur=sigma=${n6(num("radius") * px)}[${bb}]`);
        stmts.push(`[${a}][${bb}]blend=all_mode=screen:all_opacity=${n6(num("strength"))}[${out}]`);
        cur = out;
        break;
      }
      case "chromaticAberration": {
        const s = Math.round(num("pixels") * px);
        if (s > 0) chain.push("format=gbrp", `rgbashift=rh=${-s}:bh=${s}`);
        break;
      }
      case "grain":
        chain.push(`noise=alls=${Math.round(num("amount"))}:allf=t`);
        break;
      case "blur":
        if (num("radius") > 0) chain.push(`gblur=sigma=${n6(Math.max(0.1, (num("radius") * px) / 2))}`);
        break;
      case "sharpen":
        chain.push(`unsharp=5:5:${n6(num("amount"))}`);
        break;
      case "flip":
        if (p.horizontal) chain.push("hflip");
        if (p.vertical) chain.push("vflip");
        break;
      default:
        fail("unsupported", `Effect ${fx.type} has no renderer`);
    }
  }
  flush();
  return { stmts, out: cur };
}

// ------------------------------------------------------------------ main builder

export function buildGraph(ctx: GraphContext): BuiltGraph {
  const { plan, project } = ctx;
  const fps = plan.fps;
  const fpsR = `${project.settings.fps.num}/${project.settings.fps.den}`;
  const W = even(plan.width * ctx.scale);
  const H = even(plan.height * ctx.scale);
  const px = W / plan.width;
  const frames = ctx.output === "still" ? 1 : plan.rangeEnd - plan.rangeStart;
  if (frames <= 0) fail("invalid_params", "Empty render range");
  const durationSec = frames / fps;
  const inputs: string[][] = [];
  const stmts: string[] = [];

  stmts.push(`color=c=${hex(plan.background)}:s=${W}x${H}:r=${fpsR}:d=${n6(durationSec + 1)},format=gbrp[base0]`);
  let base = "base0";

  plan.layers.forEach((layer, k) => {
    const id = `L${k}`;
    const clip = layer.clip;
    const layerSec = layer.frames / fps;
    const src = `${id}src`;
    let hasAlpha = false;
    let fullFrame = false;

    // --- source
    switch (clip.type) {
      case "media": {
        const asset = findAsset(project, clip.assetId)!;
        const file = ctx.mediaPath(asset);
        if (asset.kind === "image") {
          inputs.push(["-loop", "1", "-framerate", fpsR, "-t", n6(layerSec + 0.5), "-i", file]);
          stmts.push(`[${inputs.length - 1}:v]fps=${fpsR}[${src}]`);
          hasAlpha = true;
        } else {
          const srcSeconds = layerSec * layer.speed + 0.5;
          inputs.push(["-ss", n6(layer.sourceStart), "-t", n6(srcSeconds), "-i", file]);
          const retime = layer.speed === 1 ? "setpts=PTS-STARTPTS" : `setpts=(PTS-STARTPTS)/${n6(layer.speed)}`;
          stmts.push(`[${inputs.length - 1}:v]${retime},fps=${fpsR}[${src}]`);
        }
        break;
      }
      case "scene": {
        const sf = ctx.sceneFrames(clip.sceneId);
        if (!sf) fail("render_failed", `Scene ${clip.sceneId} has not been rendered`);
        const startNumber = 1 + Math.round(layer.sourceStart * fps);
        inputs.push(["-framerate", fpsR, "-start_number", String(startNumber), "-i", path.join(sf.dir, "frame_%05d.png")]);
        stmts.push(`[${inputs.length - 1}:v]setpts=PTS-STARTPTS,fps=${fpsR}[${src}]`);
        hasAlpha = true;
        break;
      }
      case "color":
        stmts.push(`color=c=${hex(clip.fill)}:s=${W}x${H}:r=${fpsR}:d=${n6(layerSec + 1)}[${src}]`);
        fullFrame = true;
        break;
      case "text": {
        const s = clip.style;
        const font = ctx.fontFile(clip);
        const fontOpt = font ? `fontfile=${filterPath(font)}` : `font='${s.fontFamily.replace(/'/g, "")}${s.bold ? "\\:style=Bold" : ""}'`;
        const margin = Math.round(W * 0.08);
        const x = s.align === "left" ? `${margin}` : s.align === "right" ? `w-text_w-${margin}` : "(w-text_w)/2";
        // One drawtext per line: drawtext renders "\n" as a missing glyph with
        // this FFmpeg build. Lines sit on a fixed grid (same as the live preview).
        const lines = clip.text.split(/\r?\n/);
        const size = s.fontSize * px;
        const lh = size * TEXT_LINE_HEIGHT;
        const top = (H - lh * lines.length) / 2;
        const drawLine = (content: string, i: number, name: string, enable?: string) => {
          ctx.writeFile(name, content.length ? content : " ");
          const opts = [
            fontOpt,
            `textfile=${name}`,
            "expansion=none",
            `fontsize=${n6(size)}`,
            `fontcolor=${hex(s.color)}`,
            `x=${x}`,
            `y=${n6(top + i * lh)}+(${n6(lh)}-(ascent-descent))/2`,
          ];
          if (s.strokeWidth > 0) opts.push(`borderw=${n6(s.strokeWidth * px)}`, `bordercolor=${hex(s.strokeColor)}`);
          if (s.shadow) opts.push(`shadowx=${Math.max(1, Math.round(4 * px))}`, `shadowy=${Math.max(1, Math.round(4 * px))}`, `shadowcolor=${hex(s.shadowColor)}@0.6`);
          if (s.box) opts.push("box=1", `boxcolor=${hex(s.boxColor)}@${n6(s.boxOpacity)}`, `boxborderw=${Math.round(size * 0.35)}`);
          if (enable) opts.push(`enable='${enable}'`);
          return `drawtext=${opts.join(":")}`;
        };
        let draws: string[];
        if (clip.animation.in === "typewriter" || clip.animation.out === "typewriter") {
          // Typewriter: one drawtext per (line, visible prefix), enabled for the
          // frames where that prefix shows (layer-local t, half-frame margins).
          draws = [];
          lines.forEach((_, i) => {
            let runStart = 0;
            let cur: string | null = null;
            for (let j = 0; j <= layer.frames; j++) {
              const v = j < layer.frames ? revealLines(clip.text, textReveal(clip, layer.clipOffset + j))[i]! : null;
              if (v === cur) continue;
              if (cur) draws.push(drawLine(cur, i, `${id}_${i}_${draws.length}.txt`, `between(t,${n6((runStart - 0.5) / fps)},${n6((j - 0.5) / fps)})`));
              cur = v;
              runStart = j;
            }
          });
          if (!draws.length) draws = ["null"];
        } else draws = lines.map((line, i) => drawLine(line, i, `${id}_${i}.txt`));
        stmts.push(`color=c=black@0:s=${W}x${H}:r=${fpsR}:d=${n6(layerSec + 1)},format=rgba,${draws.join(",")}[${src}]`);
        hasAlpha = true;
        fullFrame = true;
        break;
      }
    }

    // --- fixed length, crop, fit
    const chain: string[] = [`tpad=stop_mode=clone:stop_duration=${n6(layerSec + 1)}`, `trim=end_frame=${layer.frames}`, "setpts=PTS-STARTPTS"];
    const cr = clip.transform.crop;
    if (cr.left || cr.right || cr.top || cr.bottom)
      chain.push(`crop=w=iw*${n6(1 - cr.left - cr.right)}:h=ih*${n6(1 - cr.top - cr.bottom)}:x=iw*${n6(cr.left)}:y=ih*${n6(cr.top)}`);

    const curves = layerCurves(clip, { width: W, height: H, hasOutgoing: layer.hasOutgoing });
    // Curves were built in output pixels for slides; keyframed x/y are in project pixels.
    const T = plus("t", layer.clipOffset / fps); // clip-relative seconds inside the layer chain
    let sMax = 0;
    for (let j = 0; j < layer.frames; j++) sMax = Math.max(sMax, evalLayer(curves, layer.clipOffset + j).scale);
    sMax = Math.max(0.02, sMax);
    const scaleAnimated = animated(curves.scale);
    const staticScale = scaleAnimated ? sMax : evalLayer(curves, layer.clipOffset).scale;

    if (!fullFrame) {
      const fit = clip.transform.fit;
      if (fit === "stretch") chain.push(`scale=w=${even(W * staticScale)}:h=${even(H * staticScale)}`);
      else {
        const f = `${fit === "fill" ? "max" : "min"}(${W}/iw,${H}/ih)*${n6(staticScale)}`;
        chain.push(`scale=w='max(2,trunc(iw*${f}/2)*2)':h='max(2,trunc(ih*${f}/2)*2)':flags=bicubic`);
      }
    } else if (staticScale !== 1) {
      chain.push(`scale=w=${even(W * staticScale)}:h=${even(H * staticScale)}`);
    }
    stmts.push(`[${src}]${chain.join(",")}[${id}p]`);
    let cur = `${id}p`;

    // --- effects (alpha-preserving wrapper for layers with transparency)
    const active = clip.effects.filter((e) => e.enabled);
    if (active.length) {
      if (hasAlpha) {
        stmts.push(`[${cur}]format=rgba,split=2[${id}c][${id}a]`);
        stmts.push(`[${id}a]alphaextract[${id}am]`);
        const fx = effectStatements(active, `${id}c`, id, px, ctx);
        stmts.push(...fx.stmts);
        stmts.push(`[${fx.out}]format=gbrp[${id}cf]`, `[${id}cf][${id}am]alphamerge[${id}fx]`);
        cur = `${id}fx`;
      } else {
        const fx = effectStatements(active, cur, id, px, ctx);
        stmts.push(...fx.stmts);
        cur = fx.out;
      }
    }

    // --- opacity, rotate, animated scale, shift
    // Order matters: filters after a per-frame `scale` keep the size they were
    // configured with and would crop later (larger) frames. Opacity therefore
    // runs first; only rotate (fixed canvas) and setpts may follow the scale.
    const post: string[] = ["format=rgba"];
    // Opacity is sampled per frame (exact match with the live preview) and
    // driven through sendcmd when it changes.
    const op: number[] = [];
    for (let j = 0; j < layer.frames; j++) op.push(Math.round(evalLayer(curves, layer.clipOffset + j).opacity * 1000) / 1000);
    const allSame = op.every((v) => v === op[0]);
    if (!allSame) {
      const lines: string[] = [];
      let prev = -1;
      op.forEach((v, j) => {
        if (v !== prev) lines.push(`${n6(j / fps)} colorchannelmixer@${id}op aa ${n6(v)};`);
        prev = v;
      });
      ctx.writeFile(`${id}op.cmd`, lines.join("\n"));
      post.push(`sendcmd=f=${id}op.cmd`, `colorchannelmixer@${id}op=aa=${n6(op[0]!)}`);
    } else if (op[0]! < 0.999) {
      post.push(`colorchannelmixer=aa=${n6(op[0]!)}`);
    }
    // Wipe/iris transitions: soft-edged alpha mask in layer coordinates, only during the transition.
    const wipe = transitionMask(clip, 0);
    if (wipe && layer.clipOffset < clip.transitionIn!.duration) {
      const d = clip.transitionIn!.duration;
      const u = `clip(${plus("T", layer.clipOffset / fps)}*${n6(fps / d)},0,1)`;
      const p = `(${u}*${u}*(3-2*${u}))`;
      const f = `(W*${n6(MASK_FEATHER)})`;
      const m =
        wipe.shape === "right" ? `((W+${f})*${p}-X)/${f}`
        : wipe.shape === "left" ? `(X-W+(W+${f})*${p})/${f}`
        : wipe.shape === "down" ? `((H+${f})*${p}-Y)/${f}`
        : wipe.shape === "up" ? `(Y-H+(H+${f})*${p})/${f}`
        : `((hypot(W,H)/2+${f})*${p}-hypot(X-W/2,Y-H/2))/${f}`;
      post.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(${m},0,1)':enable='lt(${plus("t", layer.clipOffset / fps)},${n6(d / fps)})'`);
    }
    const rotAnimated = animated(curves.rotation);
    const rot0 = evalLayer(curves, layer.clipOffset).rotation;
    if (rotAnimated || Math.abs(rot0) > 1e-6) {
      const a = rotAnimated ? `(${sumExpr(curves.rotation, T, fps, 1)})*PI/180` : n6((rot0 * Math.PI) / 180);
      post.push(`rotate=a='${a}':ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=black@0`);
    }
    if (scaleAnimated) {
      const s = `(${prodExpr(curves.scale, T, fps)})/${n6(sMax)}`;
      post.push(`scale=w='max(2,trunc(iw*${s}/2)*2)':h='max(2,trunc(ih*${s}/2)*2)':eval=frame`);
    }
    const shift = (layer.start - plan.rangeStart) / fps;
    post.push(`setpts=PTS+${n6(shift)}/TB`);
    stmts.push(`[${cur}]${post.join(",")}[${id}]`);

    // --- overlay at animated position (overlay `t` is output time)
    const To = plus("t", -shift + layer.clipOffset / fps);
    // Keyframed x/y are project pixels: scale to output. Slide curves are built in output pixels.
    const xKf = curveExpr(curves.x[0]!, To, fps, px);
    const yKf = curveExpr(curves.y[0]!, To, fps, px);
    const xRest = sumExpr(curves.x.slice(1), To, fps, 1);
    const yRest = sumExpr(curves.y.slice(1), To, fps, 1);
    const next = `base${k + 1}`;
    stmts.push(`[${base}][${id}]overlay=x='(W-w)/2+${xKf}+${xRest}':y='(H-h)/2+${yKf}+${yRest}':eval=frame:eof_action=pass:format=rgb[${next}]`);
    base = next;
  });

  // --- final video
  const vOut = "vout";
  const finalFmt = ctx.output === "still" ? "format=rgb24" : "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p";
  stmts.push(`[${base}]trim=end_frame=${frames},setpts=PTS-STARTPTS,${finalFmt}[${vOut}]`);

  // --- audio
  let audioLabel: string | undefined;
  if (ctx.includeAudio && ctx.output === "video") {
    const SR = 48000;
    const total = Math.round(durationSec * SR);
    const labels: string[] = [];
    plan.audio.forEach((seg, k) => {
      const asset = findAsset(project, seg.assetId)!;
      const segSec = seg.frames / fps;
      inputs.push(["-ss", n6(seg.sourceStart), "-t", n6(segSec * seg.speed + 0.3), "-i", ctx.mediaPath(asset)]);
      const idx = inputs.length - 1;
      const f: string[] = ["asetpts=PTS-STARTPTS"];
      let sp = seg.speed;
      while (sp > 2.0 + 1e-9) {
        f.push("atempo=2.0");
        sp /= 2;
      }
      while (sp < 0.5 - 1e-9) {
        f.push("atempo=0.5");
        sp /= 0.5;
      }
      if (Math.abs(sp - 1) > 1e-6) f.push(`atempo=${n6(sp)}`);
      f.push(`aresample=${SR}`, "aformat=sample_fmts=fltp:channel_layouts=stereo", "apad", `atrim=end_sample=${Math.round(segSec * SR)}`);
      // Gain in dB (keyframes + track) and linear fades, as one expression of clip time.
      const c = seg.clip;
      const Ta = plus("t", seg.clipOffset / fps);
      const kf = c.keyframes.volume?.length
        ? curveExpr([...c.keyframes.volume].sort((a, b) => a.frame - b.frame).map((k2) => ({ frame: k2.frame, value: k2.value, easing: k2.easing })), Ta, fps)
        : n6(c.volumeDb);
      const trackGain = seg.gainDb - c.volumeDb;
      const fades: string[] = [];
      if (c.fadeIn > 0) fades.push(`(${curveExpr([{ frame: 0, value: 0, easing: "linear" }, { frame: c.fadeIn, value: 1, easing: "linear" }], Ta, fps)})`);
      if (c.fadeOut > 0)
        fades.push(`(${curveExpr([{ frame: c.duration - c.fadeOut, value: 1, easing: "linear" }, { frame: c.duration, value: 0, easing: "linear" }], Ta, fps)})`);
      const vol = `pow(10,((${kf})+${n6(trackGain)})/20)${fades.length ? "*" + fades.join("*") : ""}`;
      f.push(`volume=volume='${vol}':eval=frame`);
      const delayMs = ((seg.start - plan.rangeStart) / fps) * 1000;
      if (delayMs > 0.5) f.push(`adelay=delays=${n6(delayMs)}:all=1`);
      const lab = `A${k}`;
      stmts.push(`[${idx}:a]${f.join(",")}[${lab}]`);
      labels.push(lab);
    });
    audioLabel = "aout";
    if (labels.length === 0) stmts.push(`anullsrc=r=${SR}:cl=stereo,atrim=end_sample=${total}[${audioLabel}]`);
    else {
      const mix = labels.length === 1 ? `[${labels[0]}]anull` : `${labels.map((l) => `[${l}]`).join("")}amix=inputs=${labels.length}:normalize=0:duration=longest`;
      stmts.push(`${mix},apad,atrim=end_sample=${total},alimiter=limit=0.977:attack=5:release=50:level=0[${audioLabel}]`);
    }
  }

  return { inputs, filter: stmts.join(";\n"), videoLabel: vOut, audioLabel, frames, durationSec, width: W, height: H };
}
