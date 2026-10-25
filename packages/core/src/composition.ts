import { TRANSITIONS } from "./effects.js";
import { ColorClipSchema, type Clip, type MixSettings, type Project, type Transition } from "./schema.js";
import type { Curve } from "./animation.js";
import { fpsValue } from "./time.js";
import { adjacentPrevious, clipEnd, findAsset, hasSpeedRamp, projectDuration, sourceTimeAt, speedAt } from "./timeline.js";

/**
 * Composition plan: a renderer-independent description of what is visible and
 * audible over a frame range. The FFmpeg graph builder (engine) and the live
 * preview (UI) both consume it, so they agree on layering and timing.
 */

export interface VisualLayer {
  clip: Clip;
  trackId: string;
  /** Absolute timeline frame of the first rendered frame. */
  start: number;
  /** Number of frames rendered. */
  frames: number;
  /** Clip-relative frame of the first rendered frame. */
  clipOffset: number;
  /** Frames rendered past the clip's end because the next clip transitions over it. */
  tail: number;
  /** Source position (seconds) of the first rendered frame. */
  sourceStart: number;
  speed: number;
  /** Transition into this clip, and whether an outgoing clip sits under it. */
  transitionIn: Transition | null;
  hasOutgoing: boolean;
  /** Transition of the next clip on the track when it plays over this clip's tail. */
  transitionOut: Transition | null;
}

export interface AudioSegment {
  clip: Clip & { type: "media" };
  trackId: string;
  assetId: string;
  start: number;
  frames: number;
  clipOffset: number;
  sourceStart: number;
  speed: number;
  /** Clip gain plus track gain. */
  gainDb: number;
  /** Automatic ducking in dB (≤ 0) over clip-relative frames; empty when not ducked. */
  duck: Curve;
}

export interface CompositionPlan {
  width: number;
  height: number;
  fps: number;
  rangeStart: number;
  rangeEnd: number;
  background: string;
  /** Bottom-most first. */
  layers: VisualLayer[];
  audio: AudioSegment[];
  sceneIds: string[];
  warnings: string[];
}

export interface PlanOptions {
  rangeStart?: number;
  rangeEnd?: number;
  /** Skip audio (e.g. still-frame previews). */
  video?: boolean;
  audio?: boolean;
}

/** Frames the outgoing clip must keep rendering under an incoming transition. */
export function transitionTail(t: Transition): number {
  const spec = TRANSITIONS.find((s) => s.type === t.type);
  if (!spec) return 0;
  // Cut-in-the-middle transitions: the outgoing shot is only seen for the first half.
  if (t.type === "dipBlack" || t.type === "flash" || t.type === "zoomThrough" || t.type === "glitchCut") return Math.ceil(t.duration / 2);
  return spec.needsOutgoing ? t.duration : 0;
}

export function buildCompositionPlan(p: Project, opts: PlanOptions = {}): CompositionPlan {
  const fps = fpsValue(p.settings.fps);
  const rs = Math.max(0, opts.rangeStart ?? 0);
  const re = opts.rangeEnd ?? projectDuration(p);
  const warnings: string[] = [];
  const layers: VisualLayer[] = [];
  const audio: AudioSegment[] = [];
  const sceneIds = new Set<string>();
  const anySolo = p.tracks.some((t) => t.solo);

  const duckSpans = p.mix.ducking.enabled ? duckTriggerSpans(p, anySolo) : [];

  // Track index 0 is the top layer, so iterate bottom-up.
  for (let ti = p.tracks.length - 1; ti >= 0; ti--) {
    const track = p.tracks[ti]!;
    const clips = [...track.clips].sort((a, b) => a.start - b.start);
    const audible = !track.muted && (!anySolo || track.solo);

    for (const clip of clips) {
      const media = clip.type === "media" ? clip : undefined;
      const asset = media ? findAsset(p, media.assetId) : undefined;
      if (media && (!asset || asset.status !== "ok")) {
        warnings.push(`Clip ${clip.id} skipped: media ${asset ? `"${asset.name}" is ${asset.status}` : "is not in the project"}`);
        continue;
      }

      // Visual layer.
      if (opts.video !== false && track.kind !== "audio" && !track.hidden && !(asset && asset.kind === "audio")) {
        const next = clips.find((c) => c.id !== clip.id && c.start === clipEnd(clip) && c.transitionIn);
        const tail = next?.transitionIn ? transitionTail(next.transitionIn) : 0;
        const absStart = clip.start;
        const absEnd = clipEnd(clip) + tail;
        const from = Math.max(absStart, rs);
        const to = Math.min(absEnd, re);
        if (to > from) {
          const clipOffset = from - clip.start;
          layers.push({
            clip,
            trackId: track.id,
            start: from,
            frames: to - from,
            clipOffset,
            tail,
            sourceStart: sourceTimeAt(clip, clipOffset, fps),
            speed: speedAt(clip, clipOffset),
            transitionIn: clip.transitionIn,
            hasOutgoing: !!adjacentPrevious(track, clip),
            transitionOut: tail > 0 ? next!.transitionIn : null,
          });
          if (clip.type === "scene") sceneIds.add(clip.sceneId);
        }
        // Dip/flash transitions: a colour layer above the incoming shot that
        // ramps up over the first half and back down over the second.
        const t = clip.transitionIn;
        if (t && (t.type === "dipBlack" || t.type === "flash")) {
          const half = Math.ceil(t.duration / 2);
          const dip = ColorClipSchema.parse({
            id: `${clip.id}__dip`,
            type: "color",
            fill: t.type === "flash" ? "#ffffff" : "#000000",
            start: clip.start,
            duration: t.duration,
            keyframes: { opacity: [{ frame: 0, value: 0, easing: "easeIn" }, { frame: half, value: 1, easing: "easeOut" }, { frame: t.duration, value: 0 }] },
          });
          const dFrom = Math.max(dip.start, rs);
          const dTo = Math.min(clipEnd(dip), re);
          if (dTo > dFrom)
            layers.push({ clip: dip, trackId: track.id, start: dFrom, frames: dTo - dFrom, clipOffset: dFrom - dip.start, tail: 0, sourceStart: 0, speed: 1, transitionIn: null, hasOutgoing: false, transitionOut: null });
        }
      }

      // Audio segment.
      const wantsAudio = opts.audio !== false && media && !media.freeze && asset?.meta.hasAudio && audible && media.audioEnabled && (track.kind === "audio" || asset.kind === "video");
      if (wantsAudio && hasSpeedRamp(media)) warnings.push(`Clip "${media.name}": its own audio is muted during the speed ramp`);
      else if (wantsAudio && media) {
        const from = Math.max(clip.start, rs);
        const to = Math.min(clipEnd(clip), re);
        if (to > from) {
          const clipOffset = from - clip.start;
          audio.push({
            clip: media,
            trackId: track.id,
            assetId: media.assetId,
            start: from,
            frames: to - from,
            clipOffset,
            sourceStart: sourceTimeAt(media, clipOffset, fps),
            speed: media.speed,
            gainDb: media.volumeDb + track.volumeDb,
            duck: track.role === "music" ? duckCurve(duckSpans, p.mix.ducking, clip.start) : [],
          });
        }
      }
    }
  }

  return {
    width: p.settings.width,
    height: p.settings.height,
    fps,
    rangeStart: rs,
    rangeEnd: re,
    background: p.settings.background,
    layers,
    audio,
    sceneIds: [...sceneIds],
    warnings,
  };
}

// ---------------------------------------------------------------- ducking

/**
 * Timeline spans [start, end) where an audible clip on a ducking-trigger track
 * (role dialogue, or sfx when enabled) plays, merged and sorted.
 */
export function duckTriggerSpans(p: Project, anySolo = p.tracks.some((t) => t.solo)): [number, number][] {
  const roles = new Set<string>(p.mix.ducking.triggers);
  const spans: [number, number][] = [];
  for (const t of p.tracks) {
    if (!roles.has(t.role) || t.muted || (anySolo && !t.solo)) continue;
    for (const c of t.clips) if (c.type === "media" && c.audioEnabled) spans.push([c.start, clipEnd(c)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  return merged;
}

/**
 * Gain curve (dB) for a ducked music clip, in frames relative to clipStart:
 * 0 dB away from triggers, -amount while they play, with linear attack before
 * and release after. Spans closer than attack + release stay ducked between.
 */
export function duckCurve(spans: [number, number][], d: MixSettings["ducking"], clipStart: number): Curve {
  if (!spans.length || d.amountDb <= 0) return [];
  const joined: [number, number][] = [];
  for (const s of spans) {
    const last = joined[joined.length - 1];
    if (last && s[0] - d.attackFrames <= last[1] + d.releaseFrames) last[1] = Math.max(last[1], s[1]);
    else joined.push([s[0], s[1]]);
  }
  const pts: Curve = [];
  for (const [a, b] of joined) {
    pts.push({ frame: a - d.attackFrames - clipStart, value: 0, easing: "linear" });
    pts.push({ frame: a - clipStart, value: -d.amountDb, easing: "linear" });
    pts.push({ frame: b - clipStart, value: -d.amountDb, easing: "linear" });
    pts.push({ frame: b + d.releaseFrames - clipStart, value: 0, easing: "linear" });
  }
  return pts;
}
