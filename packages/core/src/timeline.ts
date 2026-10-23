import type { Asset, Clip, Keyframe, KeyframeProperty, Project, Scene, Track } from "./schema.js";
import { fpsValue } from "./time.js";

export interface ClipRef {
  track: Track;
  trackIndex: number;
  clip: Clip;
  clipIndex: number;
}

export function clipEnd(c: { start: number; duration: number }): number {
  return c.start + c.duration;
}

export function findTrack(p: Project, trackId: string): Track | undefined {
  return p.tracks.find((t) => t.id === trackId);
}

export function findClip(p: Project, clipId: string): ClipRef | undefined {
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const track = p.tracks[ti]!;
    const ci = track.clips.findIndex((c) => c.id === clipId);
    if (ci >= 0) return { track, trackIndex: ti, clip: track.clips[ci]!, clipIndex: ci };
  }
  return undefined;
}

export function findAsset(p: Project, assetId: string): Asset | undefined {
  return p.assets.find((a) => a.id === assetId);
}

export function findScene(p: Project, sceneId: string): Scene | undefined {
  return p.scenes.find((s) => s.id === sceneId);
}

/** Last frame (exclusive) of any clip; at least 1. */
export function projectDuration(p: Project): number {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return Math.max(1, end);
}

export function allClips(p: Project): Clip[] {
  return p.tracks.flatMap((t) => t.clips);
}

/**
 * Length of the clip's source in seconds (Infinity for stills, text and
 * colour generators).
 */
export function sourceLength(p: Project, clip: Clip): number {
  if (clip.type === "media") {
    const a = findAsset(p, clip.assetId);
    if (!a) return Infinity;
    if (a.kind === "image") return Infinity;
    return a.meta.duration ?? Infinity;
  }
  if (clip.type === "scene") {
    const s = findScene(p, clip.sceneId);
    return s ? s.durationFrames / fpsValue(p.settings.fps) : Infinity;
  }
  return Infinity;
}

/** Seconds of source consumed by `frames` timeline frames of this clip. */
export function sourceSecondsFor(p: Project, clip: Clip, frames: number): number {
  return sourceOffset(clip, 0, frames, fpsValue(p.settings.fps));
}

/**
 * Source time (seconds) shown at a clip-relative frame: forward, held
 * (freeze) or backwards (reverse: displayed frame f is forward frame
 * duration-1-f of the same source range).
 */
export function sourceTimeAt(clip: Clip, frame: number, fps: number): number {
  if (clip.type !== "media" && clip.type !== "scene") return 0;
  if (clip.type === "media" && clip.freeze) return clip.sourceIn;
  const f = clip.type === "media" && clip.reverse ? clip.duration - 1 - frame : frame;
  return clip.sourceIn + sourceOffset(clip, 0, f, fps);
}

/** Maximum timeline duration the clip can have given its source and sourceIn. */
export function maxClipDuration(p: Project, clip: Clip): number {
  if (clip.type === "media" && clip.freeze) return Number.MAX_SAFE_INTEGER;
  const len = sourceLength(p, clip);
  if (!Number.isFinite(len)) return Number.MAX_SAFE_INTEGER;
  const sourceIn = clip.type === "media" || clip.type === "scene" ? clip.sourceIn : 0;
  const remaining = Math.max(0, len - sourceIn);
  const fps = fpsValue(p.settings.fps);
  if (hasSpeedRamp(clip)) {
    // Walk the ramp frame by frame; past the last key the speed is constant.
    const lastKey = Math.max(...clip.keyframes.speed!.map((k) => k.frame));
    let s = 0;
    let n = 0;
    for (; n <= lastKey; n++) {
      const next = s + speedAt(clip, n + 0.5) / fps;
      if (next > remaining + 1e-6) return Math.max(1, n);
      s = next;
    }
    return Math.max(1, n + Math.floor(((remaining - s) / speedAt(clip, n + 0.5)) * fps + 1e-6));
  }
  const speed = clip.type === "media" ? clip.speed : 1;
  // Small tolerance so rounding never makes a full-length clip invalid.
  return Math.max(1, Math.floor((remaining / speed) * fps + 1e-6));
}

export function sortTrackClips(t: Track): void {
  t.clips.sort((a, b) => a.start - b.start);
}

/** Clips on a track intersecting [start, end). */
export function clipsInRange(t: Track, start: number, end: number, exceptId?: string): Clip[] {
  return t.clips.filter((c) => c.id !== exceptId && c.start < end && clipEnd(c) > start);
}

export function clipsAtFrame(p: Project, frame: number): { track: Track; clip: Clip }[] {
  const out: { track: Track; clip: Clip }[] = [];
  for (const track of p.tracks) for (const clip of track.clips) if (clip.start <= frame && frame < clipEnd(clip)) out.push({ track, clip });
  return out;
}

export function isVisualTrack(t: Track): boolean {
  return t.kind !== "audio";
}

/** Clip directly before `clip` on the same track that ends exactly where it starts. */
export function adjacentPrevious(t: Track, clip: Clip): Clip | undefined {
  return t.clips.find((c) => c.id !== clip.id && clipEnd(c) === clip.start);
}

// ---------------------------------------------------------------- keyframes

export function ease(easing: Keyframe["easing"], u: number): number {
  switch (easing) {
    case "linear":
      return u;
    case "easeIn":
      return u * u;
    case "easeOut":
      return 1 - (1 - u) * (1 - u);
    case "easeInOut":
      return u * u * (3 - 2 * u);
    case "hold":
      return 0;
  }
}

/** Evaluate a keyframed property at a clip-relative frame. */
export function evalKeyframes(kfs: Keyframe[] | undefined, frame: number, fallback: number): number {
  if (!kfs || kfs.length === 0) return fallback;
  const sorted = [...kfs].sort((a, b) => a.frame - b.frame);
  const first = sorted[0]!;
  if (frame <= first.frame) return first.value;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (frame >= a.frame && frame <= b.frame) {
      const u = b.frame === a.frame ? 1 : (frame - a.frame) / (b.frame - a.frame);
      return a.value + (b.value - a.value) * ease(a.easing, u);
    }
  }
  return sorted[sorted.length - 1]!.value;
}

export function clipPropertyBase(clip: Clip, prop: KeyframeProperty): number {
  switch (prop) {
    case "opacity":
      return clip.opacity;
    case "x":
      return clip.transform.x;
    case "y":
      return clip.transform.y;
    case "scale":
      return clip.transform.scale;
    case "rotation":
      return clip.transform.rotation;
    case "volume":
      return clip.type === "media" ? clip.volumeDb : 0;
    case "speed":
      return clip.type === "media" ? clip.speed : 1;
  }
}

// ---------------------------------------------------------------- speed ramps

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 16;

/** True when the clip's speed is keyframed (a speed ramp). */
export function hasSpeedRamp(clip: Clip): boolean {
  return clip.type === "media" && !!clip.keyframes.speed?.length;
}

/** Playback speed at a clip-relative frame (constant speed or the ramp curve). */
export function speedAt(clip: Clip, frame: number): number {
  if (clip.type !== "media") return 1;
  const v = evalKeyframes(clip.keyframes.speed, frame, clip.speed);
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, v));
}

/**
 * Source seconds consumed between clip-relative frames `from` and `to`
 * (negative when to < from). Each frame advances the source by the speed at
 * its midpoint, so ramps integrate identically in the export and the preview.
 */
export function sourceOffset(clip: Clip, from: number, to: number, fps: number): number {
  if (clip.type === "media" && clip.freeze) return 0;
  if (!hasSpeedRamp(clip)) return ((to - from) / fps) * (clip.type === "media" ? clip.speed : 1);
  const [a, b, sign] = to >= from ? [from, to, 1] : [to, from, -1];
  let s = 0;
  for (let j = a; j < b; j++) s += speedAt(clip, j + 0.5);
  return (sign * s) / fps;
}

/** Value of a clip property at a clip-relative frame, honouring keyframes. */
export function clipPropertyAt(clip: Clip, prop: KeyframeProperty, frame: number): number {
  return evalKeyframes(clip.keyframes[prop], frame, clipPropertyBase(clip, prop));
}
