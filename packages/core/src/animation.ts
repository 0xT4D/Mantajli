import type { Clip, Easing, KeyframeProperty, TextClip } from "./schema.js";
import { ease } from "./timeline.js";

/**
 * Animation curves for a visual layer, in clip-relative frames.
 *
 * Every animated quantity (keyframes, fades, transitions, text animations) is
 * expressed as curves combined per channel: x/y/rotation add up, scale and
 * opacity multiply. The FFmpeg builder turns curves into filter expressions;
 * the UI evaluates them numerically. One source of truth for both.
 */

export interface CurvePoint {
  frame: number;
  value: number;
  /** Easing of the segment that starts at this point. */
  easing: Easing;
}
export type Curve = CurvePoint[];

export interface LayerCurves {
  x: Curve[];
  y: Curve[];
  rotation: Curve[];
  scale: Curve[];
  opacity: Curve[];
}

export interface LayerState {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  opacity: number;
}

const K = (frame: number, value: number, easing: Easing = "linear"): CurvePoint => ({ frame, value, easing });

function kfCurve(clip: Clip, prop: KeyframeProperty, fallback: number): Curve {
  const kfs = clip.keyframes[prop];
  if (kfs && kfs.length) return [...kfs].sort((a, b) => a.frame - b.frame).map((k) => K(k.frame, k.value, k.easing));
  return [K(0, fallback)];
}

export function layerCurves(clip: Clip, opts: { width: number; height: number; hasOutgoing: boolean }): LayerCurves {
  const { width: W, height: H } = opts;
  const dur = clip.duration;
  const c: LayerCurves = {
    x: [kfCurve(clip, "x", clip.transform.x)],
    y: [kfCurve(clip, "y", clip.transform.y)],
    rotation: [kfCurve(clip, "rotation", clip.transform.rotation)],
    scale: [kfCurve(clip, "scale", clip.transform.scale)],
    opacity: [kfCurve(clip, "opacity", clip.opacity)],
  };
  if (clip.fadeIn > 0) c.opacity.push([K(0, 0), K(clip.fadeIn, 1)]);
  if (clip.fadeOut > 0) c.opacity.push([K(dur - clip.fadeOut, 1), K(dur, 0)]);

  const t = clip.transitionIn;
  if (t) {
    const d = t.duration;
    switch (t.type) {
      case "crossfade":
        c.opacity.push([K(0, 0), K(d, 1)]);
        break;
      case "dipBlack":
      case "flash":
        // Hidden for the first half while the outgoing shot dips to colour.
        c.opacity.push([K(0, 0, "hold"), K(Math.ceil(d / 2), 1)]);
        break;
      case "slideLeft":
        c.x.push([K(0, W, "easeOut"), K(d, 0)]);
        break;
      case "slideRight":
        c.x.push([K(0, -W, "easeOut"), K(d, 0)]);
        break;
      case "slideUp":
        c.y.push([K(0, H, "easeOut"), K(d, 0)]);
        break;
      case "slideDown":
        c.y.push([K(0, -H, "easeOut"), K(d, 0)]);
        break;
      case "zoomIn":
        c.scale.push([K(0, 1.3, "easeOut"), K(d, 1)]);
        c.opacity.push([K(0, 0, "easeOut"), K(Math.max(1, Math.round(d * 0.6)), 1)]);
        break;
    }
  }

  if (clip.type === "text") {
    const ad = Math.min(clip.animation.duration, Math.floor(dur / 2));
    const a = clip.animation;
    if (ad > 0 && a.in !== "none" && a.in !== "typewriter") {
      c.opacity.push([K(0, 0, "easeOut"), K(ad, 1)]);
      if (a.in === "slideUp") c.y.push([K(0, H * 0.06, "easeOut"), K(ad, 0)]);
      if (a.in === "slideDown") c.y.push([K(0, -H * 0.06, "easeOut"), K(ad, 0)]);
      if (a.in === "slideLeft") c.x.push([K(0, W * 0.08, "easeOut"), K(ad, 0)]);
      if (a.in === "slideRight") c.x.push([K(0, -W * 0.08, "easeOut"), K(ad, 0)]);
      if (a.in === "pop") c.scale.push([K(0, 0.6, "easeOut"), K(ad, 1)]);
    }
    if (ad > 0 && a.out !== "none" && a.out !== "typewriter") {
      c.opacity.push([K(dur - ad, 1, "easeIn"), K(dur, 0)]);
      if (a.out === "slideUp") c.y.push([K(dur - ad, 0, "easeIn"), K(dur, -H * 0.06)]);
      if (a.out === "slideDown") c.y.push([K(dur - ad, 0, "easeIn"), K(dur, H * 0.06)]);
      if (a.out === "slideLeft") c.x.push([K(dur - ad, 0, "easeIn"), K(dur, -W * 0.08)]);
      if (a.out === "slideRight") c.x.push([K(dur - ad, 0, "easeIn"), K(dur, W * 0.08)]);
      if (a.out === "pop") c.scale.push([K(dur - ad, 1, "easeIn"), K(dur, 0.6)]);
    }
  }
  return c;
}

/** Characters of the text (newlines excluded), counted as code points. */
export function textCharCount(clip: TextClip): number {
  return clip.text.split(/\r?\n/).reduce((n, l) => n + Array.from(l).length, 0);
}

/**
 * Typewriter reveal: how many characters (newlines excluded, code points) are
 * visible at a clip-relative frame. Returns the full count when the clip has
 * no typewriter animation. "in" types over the animation duration; "out"
 * deletes characters over the last animation-duration frames.
 */
export function textReveal(clip: TextClip, frame: number): number {
  const total = textCharCount(clip);
  const dur = clip.duration;
  const ad = Math.min(clip.animation.duration, Math.floor(dur / 2));
  if (ad <= 0 || total === 0) return total;
  let n = total;
  if (clip.animation.in === "typewriter" && frame < ad) n = Math.min(n, Math.floor((total * (frame + 1)) / ad));
  if (clip.animation.out === "typewriter" && frame >= dur - ad) n = Math.min(n, total - Math.floor((total * (frame - (dur - ad) + 1)) / ad));
  return Math.max(0, n);
}

/** Split text into lines, each truncated so that `visible` characters show in total. */
export function revealLines(text: string, visible: number): string[] {
  let left = visible;
  return text.split(/\r?\n/).map((line) => {
    const chars = Array.from(line);
    const take = Math.max(0, Math.min(chars.length, left));
    left -= take;
    return chars.slice(0, take).join("");
  });
}

export type MaskShape = "left" | "right" | "up" | "down" | "iris";

/** Layer mask of a wipe/iris transition: shape and progress 0..1 (eased), or null. */
export function transitionMask(clip: Clip, frame: number): { shape: MaskShape; progress: number } | null {
  const t = clip.transitionIn;
  if (!t) return null;
  const shape: MaskShape | undefined = ({ wipeLeft: "left", wipeRight: "right", wipeUp: "up", wipeDown: "down", iris: "iris" } as const)[t.type as "iris"];
  if (!shape || frame >= t.duration) return null;
  return { shape, progress: ease("easeInOut", Math.max(0, frame) / t.duration) };
}

/** Feather of mask edges as a fraction of the layer's width (shared by preview and export). */
export const MASK_FEATHER = 0.03;

export function evalCurve(curve: Curve, frame: number): number {
  const first = curve[0]!;
  if (curve.length === 1 || frame <= first.frame) return first.value;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i]!;
    const b = curve[i + 1]!;
    if (frame < b.frame) {
      const u = (frame - a.frame) / (b.frame - a.frame);
      return a.value + (b.value - a.value) * ease(a.easing, u);
    }
  }
  return curve[curve.length - 1]!.value;
}

export function isConstant(curve: Curve): boolean {
  return curve.every((p) => p.value === curve[0]!.value);
}

export function evalLayer(c: LayerCurves, frame: number): LayerState {
  const sum = (cs: Curve[]) => cs.reduce((s, cv) => s + evalCurve(cv, frame), 0);
  const prod = (cs: Curve[]) => cs.reduce((s, cv) => s * evalCurve(cv, frame), 1);
  return { x: sum(c.x), y: sum(c.y), rotation: sum(c.rotation), scale: Math.max(0.01, prod(c.scale)), opacity: Math.max(0, Math.min(1, prod(c.opacity))) };
}
