import { produce, type Draft } from "immer";
import { z } from "zod";
import { lookSpec, normalizeEffectParams, EFFECT_TYPES, TRANSITION_TYPES } from "./effects.js";
import { fail } from "./errors.js";
import { cloneClip, makeColorClip, makeMediaClip, makeSceneClip, makeTextClip, makeTrack, makeSceneObject } from "./factories.js";
import { newId } from "./ids.js";
import {
  AiPlanSchema,
  AssetSchema,
  EASINGS,
  ExportSettingsSchema,
  MixSettingsSchema,
  HexColor,
  IdSchema,
  KEYFRAME_PROPERTIES,
  MarkerSchema,
  MaterialSchema,
  patchSchema,
  RationalSchema,
  SCENE_ANIM_PROPERTIES,
  SceneKeyframeSchema,
  SceneObjectSchema,
  SceneSchema,
  TRACK_KINDS,
  TextStyleSchema,
  TransformSchema,
  BLEND_MODES,
  type Clip,
  type Project,
  type Track,
} from "./schema.js";
import { buildSceneFromTemplate, SCENE_TEMPLATE_IDS } from "./sceneTemplates.js";
import { TEXT_ANIMATIONS } from "./effects.js";
import { roundSeconds } from "./time.js";
import { clipEnd, clipsInRange, evalKeyframes, findAsset, findScene, MAX_SPEED, maxClipDuration, MIN_SPEED, sortTrackClips, sourceOffset } from "./timeline.js";

export const SPEED_RAMP_PRESETS = ["slowMoHit", "speedUp", "slowDown", "flashMotion", "montage"] as const;
export type SpeedRampPreset = (typeof SPEED_RAMP_PRESETS)[number];

/** Speed keyframes for a named velocity-edit preset over a clip of `duration` frames. */
export function speedRampPreset(name: SpeedRampPreset, duration: number): { frame: number; value: number; easing: "easeInOut" | "easeIn" | "easeOut" | "linear" }[] {
  const at = (u: number) => Math.round(u * duration);
  switch (name) {
    case "slowMoHit": // fast in, slow-motion in the middle, fast out
      return [{ frame: 0, value: 2, easing: "easeInOut" }, { frame: at(0.35), value: 0.25, easing: "linear" }, { frame: at(0.65), value: 0.25, easing: "easeInOut" }, { frame: duration, value: 2, easing: "linear" }];
    case "speedUp":
      return [{ frame: 0, value: 0.5, easing: "easeIn" }, { frame: duration, value: 3, easing: "linear" }];
    case "slowDown":
      return [{ frame: 0, value: 3, easing: "easeOut" }, { frame: duration, value: 0.4, easing: "linear" }];
    case "flashMotion": // whip fast, short slow-mo, whip fast
      return [{ frame: 0, value: 4, easing: "easeOut" }, { frame: at(0.4), value: 0.3, easing: "easeIn" }, { frame: at(0.6), value: 0.3, easing: "easeIn" }, { frame: duration, value: 4, easing: "linear" }];
    case "montage": // the classic velocity edit: 1× → 3× → 0.3× → 1×
      return [{ frame: 0, value: 1, easing: "easeIn" }, { frame: at(0.3), value: 3, easing: "easeInOut" }, { frame: at(0.55), value: 0.3, easing: "easeInOut" }, { frame: duration, value: 1, easing: "linear" }];
  }
}

function assertSpeedRampable(p: D, clip: Draft<Clip>, values: number[]) {
  if (clip.type !== "media") fail("invalid_params", "Only video media clips can have a speed ramp");
  const a = findAsset(p as Project, clip.assetId);
  if (a && a.kind !== "video") fail("invalid_params", `Speed ramps need a video clip ("${a.name}" is ${a.kind})`);
  if (values.some((v) => !(v >= MIN_SPEED && v <= MAX_SPEED))) fail("invalid_params", `Ramp speeds must be between ${MIN_SPEED} and ${MAX_SPEED}`);
}

/**
 * Editing commands: the only way project state changes.
 *
 * Each command has a zod schema for its params and a pure `apply` that mutates
 * an immer draft and returns a result. `applyCommand` turns that into an
 * immutable before/after pair, which the session history stores for undo.
 */

type D = Draft<Project>;

interface CommandDef<S extends z.ZodType, R> {
  description: string;
  params: S;
  apply(p: D, params: z.output<S>): R;
}

function def<S extends z.ZodType, R>(d: CommandDef<S, R>): CommandDef<S, R> {
  return d;
}

// ---------------------------------------------------------------- helpers

function getTrack(p: D, trackId: string): Draft<Track> {
  const t = p.tracks.find((t) => t.id === trackId);
  if (!t) fail("not_found", `Track ${trackId} not found`);
  return t;
}

function getClip(p: D, clipId: string): { track: Draft<Track>; clip: Draft<Clip>; index: number } {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  fail("not_found", `Clip ${clipId} not found`);
}

function assertUnlocked(t: Draft<Track>) {
  if (t.locked) fail("locked", `Track "${t.name}" is locked`);
}

function fpsOf(p: D) {
  return p.settings.fps.num / p.settings.fps.den;
}

function assertClipFitsTrack(p: D, track: Draft<Track>, clip: Clip) {
  if (track.kind === "audio") {
    if (clip.type !== "media") fail("invalid_params", `Only media clips can go on audio track "${track.name}"`);
    const a = findAsset(p as Project, clip.assetId);
    if (a && !a.meta.hasAudio) fail("invalid_params", `Asset "${a.name}" has no audio stream`);
  } else if (clip.type === "media") {
    const a = findAsset(p as Project, clip.assetId);
    if (a && a.kind === "audio") fail("invalid_params", `Audio asset "${a.name}" must go on an audio track`);
  }
}

/** Shift a clip's start edge by `delta` frames, keeping the content in place. */
function trimStartBy(p: D, clip: Draft<Clip>, delta: number) {
  if (clip.type === "media" || clip.type === "scene") {
    const nextIn = roundSeconds(clip.sourceIn + sourceOffset(clip as Clip, 0, delta, fpsOf(p)));
    if (nextIn < -1e-6) fail("conflict", "Cannot extend clip before the start of its source");
    clip.sourceIn = Math.max(0, nextIn);
  }
  clip.start += delta;
  clip.duration -= delta;
  shiftKeyframes(clip, -delta);
}

/**
 * Move keyframes by `by` frames after a trim/split (clip.duration already
 * updated). Keys that fall outside are dropped; a key is inserted at each cut
 * edge with the value the curve had there, so the animation keeps its shape.
 */
function shiftKeyframes(clip: Draft<Clip>, by: number) {
  for (const key of Object.keys(clip.keyframes) as (keyof typeof clip.keyframes)[]) {
    const list = clip.keyframes[key];
    if (!list?.length) continue;
    const orig = list.map((k) => ({ ...k }));
    const moved = orig.map((k) => ({ ...k, frame: k.frame + by }));
    const inside = moved.filter((k) => k.frame >= 0 && k.frame <= clip.duration);
    const easingAt = (f: number) => [...moved].reverse().find((k) => k.frame <= f)?.easing ?? orig[0]!.easing;
    if (moved.some((k) => k.frame < 0) && !inside.some((k) => k.frame === 0)) inside.unshift({ frame: 0, value: evalKeyframes(orig, -by, 0), easing: easingAt(0) });
    if (moved.some((k) => k.frame > clip.duration) && !inside.some((k) => k.frame === clip.duration))
      inside.push({ frame: clip.duration, value: evalKeyframes(orig, clip.duration - by, 0), easing: "linear" });
    clip.keyframes[key] = inside;
  }
}

/**
 * Clear [start, end) on a track (overwrite edit): clips fully inside are
 * removed, clips spanning it are split, partially overlapping clips trimmed.
 */
function clearRange(p: D, track: Draft<Track>, start: number, end: number, exceptId?: string) {
  for (const c of clipsInRange(track as Track, start, end, exceptId)) {
    const idx = track.clips.findIndex((x) => x.id === c.id);
    const clip = track.clips[idx]!;
    const cEnd = clipEnd(clip);
    if (clip.start >= start && cEnd <= end) {
      track.clips.splice(idx, 1);
    } else if (clip.start < start && cEnd > end) {
      const right = cloneClip(clip as Clip) as Draft<Clip>;
      clip.duration = start - clip.start;
      clip.fadeOut = Math.min(clip.fadeOut, clip.duration);
      shiftKeyframes(clip, 0);
      trimStartBy(p, right, end - right.start);
      right.transitionIn = null;
      right.fadeIn = 0;
      track.clips.push(right);
    } else if (clip.start < start) {
      clip.duration = start - clip.start;
      clip.fadeOut = Math.min(clip.fadeOut, clip.duration);
      shiftKeyframes(clip, 0);
    } else {
      trimStartBy(p, clip, end - clip.start);
      clip.transitionIn = null;
    }
  }
  sortTrackClips(track as Track);
}

type OverlapMode = "overwrite" | "error";

function place(p: D, track: Draft<Track>, clip: Draft<Clip>, mode: OverlapMode) {
  const overlaps = clipsInRange(track as Track, clip.start, clipEnd(clip), clip.id);
  if (overlaps.length) {
    if (mode === "error")
      fail("conflict", `Clip would overlap ${overlaps.map((c) => c.id).join(", ")} on track "${track.name}"`, { overlaps: overlaps.map((c) => c.id) });
    clearRange(p, track, clip.start, clipEnd(clip), clip.id);
  }
}

function clampToSource(p: D, clip: Draft<Clip>) {
  const max = maxClipDuration(p as Project, clip as Clip);
  if (clip.duration > max) clip.duration = max;
  if (clip.duration < 1) fail("conflict", "Clip has no source material left at this in-point");
}

const OverlapModeSchema = z.enum(["overwrite", "error"]).default("overwrite");

const KeyframeInput = z.object({
  frame: z.number().int().nonnegative(),
  value: z.number(),
  easing: z.enum(EASINGS).default("easeInOut"),
});

// ---------------------------------------------------------------- commands

export const COMMANDS = {
  "project.rename": def({
    description: "Rename the project.",
    params: z.object({ name: z.string().min(1).max(200) }),
    apply(p, { name }) {
      p.name = name;
    },
  }),

  "project.setSettings": def({
    description: "Change resolution, frame rate or background colour.",
    params: z.object({
      width: z.number().int().min(16).max(8192).optional(),
      height: z.number().int().min(16).max(8192).optional(),
      fps: RationalSchema.optional(),
      background: HexColor.optional(),
    }),
    apply(p, s) {
      if (s.fps && (s.fps.num !== p.settings.fps.num || s.fps.den !== p.settings.fps.den)) {
        // Re-time frame-based values so timeline positions keep their seconds.
        const ratio = s.fps.num / s.fps.den / fpsOf(p);
        const r = (f: number) => Math.round(f * ratio);
        for (const t of p.tracks)
          for (const c of t.clips) {
            c.start = r(c.start);
            c.duration = Math.max(1, r(c.duration));
            c.fadeIn = r(c.fadeIn);
            c.fadeOut = r(c.fadeOut);
            if (c.transitionIn) c.transitionIn.duration = Math.max(1, r(c.transitionIn.duration));
            for (const list of Object.values(c.keyframes)) for (const k of list ?? []) k.frame = r(k.frame);
          }
        for (const m of p.markers) m.frame = r(m.frame);
        for (const s2 of p.scenes) {
          s2.durationFrames = Math.max(1, r(s2.durationFrames));
          for (const o of s2.objects) for (const a of o.animation) for (const k of a.keyframes) k.frame = r(k.frame);
        }
        p.settings.fps = s.fps;
      }
      if (s.width) p.settings.width = s.width;
      if (s.height) p.settings.height = s.height;
      if (s.background) p.settings.background = s.background;
    },
  }),

  "project.setMix": def({
    description: "Update the automatic mix (music ducking under dialogue/SFX clips).",
    params: z.object({ ducking: patchSchema(MixSettingsSchema.shape.ducking.unwrap()).optional() }),
    apply(p, s) {
      if (s.ducking) Object.assign(p.mix.ducking, Object.fromEntries(Object.entries(s.ducking).filter(([, v]) => v !== undefined)));
    },
  }),

  "project.setExport": def({
    description: "Update export settings.",
    params: patchSchema(ExportSettingsSchema),
    apply(p, s) {
      Object.assign(p.export, s);
    },
  }),

  // ------------------------------------------------------------ assets

  "asset.add": def({
    description: "Register an imported asset (engine use).",
    params: z.object({ asset: AssetSchema }),
    apply(p, { asset }) {
      if (p.assets.some((a) => a.id === asset.id)) fail("conflict", `Asset ${asset.id} already exists`);
      p.assets.push(asset);
      return { assetId: asset.id };
    },
  }),

  "asset.update": def({
    description: "Update asset metadata, tags, derived files or path.",
    params: z.object({ assetId: IdSchema, patch: patchSchema(AssetSchema.omit({ id: true, kind: true })) }),
    apply(p, { assetId, patch }) {
      const a = p.assets.find((a) => a.id === assetId);
      if (!a) fail("not_found", `Asset ${assetId} not found`);
      Object.assign(a, patch);
    },
  }),

  "asset.remove": def({
    description: "Remove an asset from the project (never deletes the source file). With force, clips using it are removed too.",
    params: z.object({ assetId: IdSchema, force: z.boolean().default(false) }),
    apply(p, { assetId, force }) {
      const used = p.tracks.flatMap((t) => t.clips).filter((c) => c.type === "media" && c.assetId === assetId);
      if (used.length && !force) fail("conflict", `Asset is used by ${used.length} clip(s); pass force to remove them`);
      for (const t of p.tracks) t.clips = t.clips.filter((c) => !(c.type === "media" && c.assetId === assetId));
      p.assets = p.assets.filter((a) => a.id !== assetId);
      return { removedClips: used.map((c) => c.id) };
    },
  }),

  // ------------------------------------------------------------ tracks

  "track.add": def({
    description: "Add a track. index 0 is the top layer.",
    params: z.object({
      kind: z.enum(TRACK_KINDS),
      name: z.string().max(80).optional(),
      index: z.number().int().nonnegative().optional(),
      role: z.enum(["general", "music", "sfx", "dialogue"]).optional(),
    }),
    apply(p, { kind, name, index, role }) {
      const n = p.tracks.filter((t) => t.kind === kind).length + 1;
      const label = name ?? (kind === "audio" ? `A${n}` : kind === "text" ? `T${n}` : kind === "scene" ? `3D${n}` : `V${n}`);
      const t = makeTrack(kind, label, role ? { role } : {});
      // Default: visual tracks go above existing visual tracks, audio at the bottom.
      const at = index ?? (kind === "audio" ? p.tracks.length : 0);
      p.tracks.splice(Math.min(at, p.tracks.length), 0, t);
      return { trackId: t.id };
    },
  }),

  "track.update": def({
    description: "Rename, mute, solo, lock, hide or set the volume of a track.",
    params: z.object({
      trackId: IdSchema,
      name: z.string().min(1).max(80).optional(),
      muted: z.boolean().optional(),
      solo: z.boolean().optional(),
      locked: z.boolean().optional(),
      hidden: z.boolean().optional(),
      volumeDb: z.number().min(-60).max(12).optional(),
      role: z.enum(["general", "music", "sfx", "dialogue"]).optional(),
    }),
    apply(p, { trackId, ...patch }) {
      const t = getTrack(p, trackId);
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (t as Record<string, unknown>)[k] = v;
    },
  }),

  "track.move": def({
    description: "Reorder a track.",
    params: z.object({ trackId: IdSchema, index: z.number().int().nonnegative() }),
    apply(p, { trackId, index }) {
      const i = p.tracks.findIndex((t) => t.id === trackId);
      if (i < 0) fail("not_found", `Track ${trackId} not found`);
      const [t] = p.tracks.splice(i, 1);
      p.tracks.splice(Math.min(index, p.tracks.length), 0, t!);
    },
  }),

  "track.remove": def({
    description: "Delete a track and its clips.",
    params: z.object({ trackId: IdSchema }),
    apply(p, { trackId }) {
      const t = getTrack(p, trackId);
      assertUnlocked(t);
      p.tracks = p.tracks.filter((x) => x.id !== trackId);
    },
  }),

  // ------------------------------------------------------------ clips

  "clip.add": def({
    description: "Add a media, text, scene or colour clip to a track.",
    params: z.object({
      trackId: IdSchema,
      clip: z.discriminatedUnion("type", [
        z.object({
          type: z.literal("media"),
          assetId: IdSchema,
          start: z.number().int().nonnegative(),
          duration: z.number().int().positive().optional(),
          sourceIn: z.number().nonnegative().default(0),
          speed: z.number().min(0.1).max(16).default(1),
          name: z.string().optional(),
        }),
        z.object({
          type: z.literal("text"),
          text: z.string().min(1).max(2000),
          start: z.number().int().nonnegative(),
          duration: z.number().int().positive(),
          style: TextStyleSchema.partial().optional(),
          animation: z.object({ in: z.enum(TEXT_ANIMATIONS), out: z.enum(TEXT_ANIMATIONS), duration: z.number().int().min(1).max(300) }).partial().optional(),
          transform: TransformSchema.partial().optional(),
          name: z.string().optional(),
        }),
        z.object({
          type: z.literal("scene"),
          sceneId: IdSchema,
          start: z.number().int().nonnegative(),
          duration: z.number().int().positive().optional(),
          sourceIn: z.number().nonnegative().default(0),
          name: z.string().optional(),
        }),
        z.object({
          type: z.literal("color"),
          fill: HexColor,
          start: z.number().int().nonnegative(),
          duration: z.number().int().positive(),
          name: z.string().optional(),
        }),
      ]),
      mode: OverlapModeSchema,
    }),
    apply(p, { trackId, clip: init, mode }) {
      const track = getTrack(p, trackId);
      assertUnlocked(track);
      let clip: Clip;
      switch (init.type) {
        case "media": {
          const a = findAsset(p as Project, init.assetId);
          if (!a) fail("missing_asset", `Asset ${init.assetId} not found`);
          if (!["video", "audio", "image"].includes(a.kind)) fail("invalid_params", `Asset kind "${a.kind}" cannot be placed on the timeline`);
          const fallback = a.kind === "image" ? Math.round(fpsOf(p) * 3) : Number.MAX_SAFE_INTEGER;
          clip = makeMediaClip({ ...init, name: init.name ?? a.name, duration: init.duration ?? fallback });
          break;
        }
        case "text":
          clip = makeTextClip({
            ...init,
            name: init.name ?? init.text.slice(0, 40),
            style: TextStyleSchema.parse(init.style ?? {}),
            animation: { in: "fade", out: "fade", duration: 12, ...init.animation },
            transform: TransformSchema.parse(init.transform ?? {}),
          });
          break;
        case "scene": {
          const s = findScene(p as Project, init.sceneId);
          if (!s) fail("not_found", `Scene ${init.sceneId} not found`);
          clip = makeSceneClip({ ...init, name: init.name ?? s.name, duration: init.duration ?? s.durationFrames });
          break;
        }
        case "color":
          clip = makeColorClip({ ...init, name: init.name ?? "Color" });
          break;
      }
      assertClipFitsTrack(p, track, clip);
      const draft = clip as Draft<Clip>;
      clampToSource(p, draft);
      place(p, track, draft, mode);
      track.clips.push(draft);
      sortTrackClips(track as Track);
      return { clipId: clip.id, start: clip.start, duration: draft.duration };
    },
  }),

  "clip.move": def({
    description: "Move a clip to a new start frame and optionally another track.",
    params: z.object({
      clipId: IdSchema,
      start: z.number().int().nonnegative(),
      trackId: IdSchema.optional(),
      mode: OverlapModeSchema,
    }),
    apply(p, { clipId, start, trackId, mode }) {
      const { track, index } = getClip(p, clipId);
      assertUnlocked(track);
      const target = trackId ? getTrack(p, trackId) : track;
      assertUnlocked(target);
      const [clip] = track.clips.splice(index, 1);
      clip!.start = start;
      assertClipFitsTrack(p, target, clip as Clip);
      place(p, target, clip!, mode);
      target.clips.push(clip!);
      sortTrackClips(target as Track);
      return { clipId, start, trackId: target.id };
    },
  }),

  "clip.trim": def({
    description: "Trim a clip's start or end edge to an absolute timeline frame.",
    params: z.object({
      clipId: IdSchema,
      edge: z.enum(["start", "end"]),
      frame: z.number().int().nonnegative(),
      mode: OverlapModeSchema,
    }),
    apply(p, { clipId, edge, frame, mode }) {
      const { track, clip } = getClip(p, clipId);
      assertUnlocked(track);
      if (edge === "start") {
        if (frame >= clipEnd(clip)) fail("invalid_params", "Start trim must be before the clip end");
        trimStartBy(p, clip, frame - clip.start);
      } else {
        if (frame <= clip.start) fail("invalid_params", "End trim must be after the clip start");
        clip.duration = frame - clip.start;
        clampToSource(p, clip);
        shiftKeyframes(clip, 0);
      }
      clip.fadeIn = Math.min(clip.fadeIn, clip.duration);
      clip.fadeOut = Math.min(clip.fadeOut, clip.duration);
      place(p, track, clip, mode);
      sortTrackClips(track as Track);
      return { clipId, start: clip.start, duration: clip.duration };
    },
  }),

  "clip.split": def({
    description: "Split a clip at an absolute timeline frame. Returns the id of the right half.",
    params: z.object({ clipId: IdSchema, frame: z.number().int().nonnegative() }),
    apply(p, { clipId, frame }) {
      const { track, clip } = getClip(p, clipId);
      assertUnlocked(track);
      if (frame <= clip.start || frame >= clipEnd(clip)) fail("invalid_params", `Split frame ${frame} must be inside the clip (${clip.start}–${clipEnd(clip)})`);
      const right = cloneClip(clip as Clip) as Draft<Clip>;
      const fadeOut = clip.fadeOut;
      clip.duration = frame - clip.start;
      clip.fadeOut = 0;
      shiftKeyframes(clip, 0);
      trimStartBy(p, right, frame - right.start);
      right.transitionIn = null;
      right.fadeIn = 0;
      right.fadeOut = Math.min(fadeOut, right.duration);
      track.clips.push(right);
      sortTrackClips(track as Track);
      return { leftId: clip.id, rightId: right.id };
    },
  }),

  "clip.remove": def({
    description: "Delete clips. With ripple, later clips on the same track shift left to close the gap.",
    params: z.object({ clipIds: z.array(IdSchema).min(1), ripple: z.boolean().default(false) }),
    apply(p, { clipIds, ripple }) {
      for (const id of clipIds) {
        const { track, clip, index } = getClip(p, id);
        assertUnlocked(track);
        track.clips.splice(index, 1);
        if (ripple) for (const c of track.clips) if (c.start >= clipEnd(clip)) c.start -= clip.duration;
      }
      return { removed: clipIds };
    },
  }),

  "clip.duplicate": def({
    description: "Duplicate a clip, by default right after the original.",
    params: z.object({ clipId: IdSchema, start: z.number().int().nonnegative().optional(), trackId: IdSchema.optional(), mode: OverlapModeSchema }),
    apply(p, { clipId, start, trackId, mode }) {
      const { track, clip } = getClip(p, clipId);
      const target = trackId ? getTrack(p, trackId) : track;
      assertUnlocked(target);
      const copy = cloneClip(clip as Clip) as Draft<Clip>;
      copy.start = start ?? clipEnd(clip);
      assertClipFitsTrack(p, target, copy as Clip);
      place(p, target, copy, mode);
      target.clips.push(copy);
      sortTrackClips(target as Track);
      return { clipId: copy.id };
    },
  }),

  "clip.update": def({
    description: "Change clip properties: name, opacity, blendMode, transform, fades, speed, volume, text and style.",
    params: z.object({
      clipId: IdSchema,
      props: z.object({
        name: z.string().max(200).optional(),
        opacity: z.number().min(0).max(1).optional(),
        blendMode: z.enum(BLEND_MODES).optional(),
        transform: patchSchema(TransformSchema, { deep: true }).optional(),
        fadeIn: z.number().int().nonnegative().optional(),
        fadeOut: z.number().int().nonnegative().optional(),
        speed: z.number().min(0.1).max(16).optional(),
        sourceIn: z.number().nonnegative().optional(),
        volumeDb: z.number().min(-60).max(24).optional(),
        audioEnabled: z.boolean().optional(),
        text: z.string().min(1).max(2000).optional(),
        style: patchSchema(TextStyleSchema).optional(),
        animation: z.object({ in: z.enum(TEXT_ANIMATIONS), out: z.enum(TEXT_ANIMATIONS), duration: z.number().int().min(1).max(300) }).partial().optional(),
        fill: HexColor.optional(),
        color: z.string().optional(),
      }),
    }),
    apply(p, { clipId, props }) {
      const { track, clip } = getClip(p, clipId);
      assertUnlocked(track);
      const reject = (k: string): never => fail("invalid_params", `Property "${k}" does not apply to ${clip.type} clips`);
      if (props.name !== undefined) clip.name = props.name;
      if (props.opacity !== undefined) clip.opacity = props.opacity;
      if (props.blendMode !== undefined) clip.blendMode = props.blendMode;
      if (props.transform) {
        const { crop, ...rest } = props.transform;
        Object.assign(clip.transform, rest);
        if (crop) Object.assign(clip.transform.crop, crop);
      }
      if (props.fadeIn !== undefined) clip.fadeIn = Math.min(props.fadeIn, clip.duration);
      if (props.fadeOut !== undefined) clip.fadeOut = Math.min(props.fadeOut, clip.duration);
      if (props.color !== undefined) clip.color = props.color;
      for (const k of ["speed", "volumeDb", "audioEnabled"] as const)
        if (props[k] !== undefined) {
          if (clip.type !== "media") reject(k);
          (clip as Record<string, unknown>)[k] = props[k];
        }
      if (props.sourceIn !== undefined) {
        if (clip.type === "media" || clip.type === "scene") clip.sourceIn = props.sourceIn;
        else reject("sourceIn");
      }
      if (props.speed !== undefined || props.sourceIn !== undefined) clampToSource(p, clip);
      if (props.text !== undefined || props.style || props.animation) {
        if (clip.type !== "text") return reject("text/style/animation");
        if (props.text !== undefined) clip.text = props.text;
        if (props.style) Object.assign(clip.style, props.style);
        if (props.animation) Object.assign(clip.animation, props.animation);
      }
      if (props.fill !== undefined) {
        if (clip.type !== "color") return reject("fill");
        clip.fill = props.fill;
      }
      return { clipId, duration: clip.duration };
    },
  }),

  "clip.setTransition": def({
    description: "Set (or clear with null) the transition into a clip from the previous shot on its track.",
    params: z.object({
      clipId: IdSchema,
      transition: z.object({ type: z.enum(TRANSITION_TYPES as [string, ...string[]]), duration: z.number().int().min(1).max(600) }).nullable(),
    }),
    apply(p, { clipId, transition }) {
      const { track, clip } = getClip(p, clipId);
      assertUnlocked(track);
      if (transition && transition.duration > clip.duration) fail("invalid_params", `Transition (${transition.duration}f) is longer than the clip (${clip.duration}f)`);
      clip.transitionIn = transition;
    },
  }),

  // ------------------------------------------------------------ keyframes

  "keyframe.set": def({
    description: "Add or replace a keyframe (clip-relative frame) on opacity, x, y, scale, rotation or volume.",
    params: z.object({ clipId: IdSchema, property: z.enum(KEYFRAME_PROPERTIES), keyframe: KeyframeInput }),
    apply(p, { clipId, property, keyframe }) {
      const { track, clip } = getClip(p, clipId);
      assertUnlocked(track);
      if (keyframe.frame > clip.duration) fail("invalid_params", `Keyframe frame ${keyframe.frame} is beyond the clip duration ${clip.duration}`);
      if (property === "speed") assertSpeedRampable(p, clip, [keyframe.value]);
      const list = (clip.keyframes[property] ??= []);
      const i = list.findIndex((k) => k.frame === keyframe.frame);
      if (i >= 0) list[i] = keyframe;
      else list.push(keyframe);
      list.sort((a, b) => a.frame - b.frame);
      if (property === "speed") clampToSource(p, clip);
    },
  }),

  "clip.setSpeedRamp": def({
    description:
      "Replace a video clip's speed ramp (velocity edit) with keyframes, a preset, or clear it (null). Speeds 0.1–16×; frames are clip-relative. The clip's own audio is muted while ramped.",
    params: z.object({
      clipId: IdSchema,
      ramp: z.union([z.array(KeyframeInput).min(1).max(200), z.enum(SPEED_RAMP_PRESETS), z.null()]),
    }),
    apply(p, { clipId, ramp }) {
      const { track, clip } = getClip(p, clipId);
      assertUnlocked(track);
      if (ramp === null) delete clip.keyframes.speed;
      else {
        const keys = typeof ramp === "string" ? speedRampPreset(ramp, clip.duration) : ramp;
        assertSpeedRampable(p, clip, keys.map((k) => k.value));
        if (keys.some((k) => k.frame > clip.duration)) fail("invalid_params", `Speed keyframes must lie within the clip (0–${clip.duration})`);
        clip.keyframes.speed = [...keys].sort((a, b) => a.frame - b.frame);
      }
      clampToSource(p, clip);
      return { duration: clip.duration };
    },
  }),

  "keyframe.remove": def({
    description: "Remove keyframes at a frame, or all keyframes of a property when frame is omitted.",
    params: z.object({ clipId: IdSchema, property: z.enum(KEYFRAME_PROPERTIES), frame: z.number().int().nonnegative().optional() }),
    apply(p, { clipId, property, frame }) {
      const { track, clip } = getClip(p, clipId);
      assertUnlocked(track);
      if (frame === undefined) delete clip.keyframes[property];
      else {
        const list = (clip.keyframes[property] ?? []).filter((k) => k.frame !== frame);
        if (list.length) clip.keyframes[property] = list;
        else delete clip.keyframes[property];
      }
      if (property === "speed") clampToSource(p, clip);
    },
  }),

  // ------------------------------------------------------------ effects

  "effect.add": def({
    description: "Append an effect to a clip's effect stack.",
    params: z.object({
      clipId: IdSchema,
      type: z.enum(EFFECT_TYPES as [string, ...string[]]),
      params: z.record(z.string(), z.unknown()).default({}),
      index: z.number().int().nonnegative().optional(),
    }),
    apply(p, { clipId, type, params, index }) {
      const { track, clip } = getClip(p, clipId);
      assertUnlocked(track);
      if (track.kind === "audio") fail("unsupported", "Video effects cannot be applied to audio clips");
      const normalized = normalizeEffectParams(type, params);
      if (type === "lut") {
        const a = findAsset(p as Project, String(normalized.assetId));
        if (!a || a.kind !== "lut") fail("missing_asset", "LUT effect needs an imported LUT asset id in params.assetId");
      }
      const fx = { id: newId("fx"), type, enabled: true, params: normalized };
      clip.effects.splice(index ?? clip.effects.length, 0, fx);
      return { effectId: fx.id };
    },
  }),

  "effect.update": def({
    description: "Change effect parameters or enable/disable it.",
    params: z.object({ clipId: IdSchema, effectId: IdSchema, params: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean().optional() }),
    apply(p, { clipId, effectId, params, enabled }) {
      const { track, clip } = getClip(p, clipId);
      assertUnlocked(track);
      const fx = clip.effects.find((e) => e.id === effectId);
      if (!fx) fail("not_found", `Effect ${effectId} not found on clip ${clipId}`);
      if (params) fx.params = normalizeEffectParams(fx.type, { ...fx.params, ...params });
      if (enabled !== undefined) fx.enabled = enabled;
    },
  }),

  "effect.remove": def({
    description: "Remove an effect from a clip.",
    params: z.object({ clipId: IdSchema, effectId: IdSchema }),
    apply(p, { clipId, effectId }) {
      const { track, clip } = getClip(p, clipId);
      assertUnlocked(track);
      const before = clip.effects.length;
      clip.effects = clip.effects.filter((e) => e.id !== effectId);
      if (clip.effects.length === before) fail("not_found", `Effect ${effectId} not found`);
    },
  }),

  "effect.move": def({
    description: "Reorder an effect within the clip stack.",
    params: z.object({ clipId: IdSchema, effectId: IdSchema, index: z.number().int().nonnegative() }),
    apply(p, { clipId, effectId, index }) {
      const { clip } = getClip(p, clipId);
      const i = clip.effects.findIndex((e) => e.id === effectId);
      if (i < 0) fail("not_found", `Effect ${effectId} not found`);
      const [fx] = clip.effects.splice(i, 1);
      clip.effects.splice(Math.min(index, clip.effects.length), 0, fx!);
    },
  }),

  // ------------------------------------------------------------ auto edit

  "timeline.autoEdit": def({
    description:
      "Cut a beat-synced montage: fill [start, end) of a track with shots from the given assets, cutting every N beat markers (beats or downbeats). Assets rotate; reused videos continue from where they left off. Optional transition, look and beat pulse on every shot.",
    params: z.object({
      trackId: IdSchema,
      assetIds: z.array(IdSchema).min(1).max(200),
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
      every: z.number().int().min(1).max(32).default(2),
      on: z.enum(["beats", "downbeats"]).default("beats"),
      transition: z.object({ type: z.enum(TRANSITION_TYPES as [string, ...string[]]), duration: z.number().int().min(1).max(60) }).nullable().default(null),
      look: z.string().optional(),
      pulse: z.number().min(0).max(0.5).default(0),
    }),
    apply(p, o) {
      if (o.end <= o.start) fail("invalid_params", "end must be after start");
      const kinds = o.on === "downbeats" ? ["downbeat"] : ["beat", "downbeat"];
      const beats = [...new Set(p.markers.filter((m) => kinds.includes(m.kind) && m.frame > o.start && m.frame < o.end).map((m) => m.frame))].sort((a, b) => a - b);
      if (!beats.length) fail("invalid_params", `No ${o.on} markers between frames ${o.start} and ${o.end}. Analyse the music first (beat markers).`);
      const cuts = [o.start, ...beats.filter((_, i) => (i + 1) % o.every === 0), o.end];
      const look = o.look ? (lookSpec(o.look) ?? fail("unsupported", `Unknown look ${o.look}`)) : undefined;
      const assets = o.assetIds.map((id) => {
        const a = findAsset(p as Project, id) ?? fail("missing_asset", `Asset ${id} not found`);
        if (a.kind !== "video" && a.kind !== "image") fail("invalid_params", `"${a.name}" is not a video or image`);
        return a;
      });
      const fps = fpsOf(p);
      const usedUntil = new Map<string, number>();
      const clipIds: string[] = [];
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = assets[i % assets.length]!;
        const frames = cuts[i + 1]! - cuts[i]!;
        let sourceIn = 0;
        if (a.kind === "video") {
          const len = a.meta.duration ?? Infinity;
          sourceIn = usedUntil.get(a.id) ?? 0;
          if (sourceIn + frames / fps > len) sourceIn = 0; // wrap around to the start of the clip
          usedUntil.set(a.id, sourceIn + frames / fps);
        }
        const r = sub(p, "clip.add", { trackId: o.trackId, clip: { type: "media", assetId: a.id, start: cuts[i]!, duration: frames, sourceIn: roundSeconds(sourceIn) } });
        clipIds.push(r.clipId);
        if (o.transition && i > 0) sub(p, "clip.setTransition", { clipId: r.clipId, transition: { type: o.transition.type, duration: Math.min(o.transition.duration, r.duration) } });
        for (const e of look?.effects ?? []) sub(p, "effect.add", { clipId: r.clipId, type: e.type, params: e.params });
        if (o.pulse > 0) sub(p, "effect.add", { clipId: r.clipId, type: "beatPulse", params: { zoom: o.pulse, on: o.on } });
      }
      return { clipIds, shots: clipIds.length };
    },
  }),

  // ------------------------------------------------------------ markers

  "marker.add": def({
    description: "Add a timeline marker.",
    params: MarkerSchema.omit({ id: true }).partial().required({ frame: true }),
    apply(p, m) {
      const marker = MarkerSchema.parse({ id: newId("mk"), ...m });
      p.markers.push(marker);
      p.markers.sort((a, b) => a.frame - b.frame);
      return { markerId: marker.id };
    },
  }),

  "marker.update": def({
    description: "Move or relabel a marker.",
    params: z.object({ markerId: IdSchema, frame: z.number().int().nonnegative().optional(), label: z.string().optional(), kind: MarkerSchema.shape.kind.optional() }),
    apply(p, { markerId, ...patch }) {
      const m = p.markers.find((m) => m.id === markerId);
      if (!m) fail("not_found", `Marker ${markerId} not found`);
      if (patch.frame !== undefined) m.frame = patch.frame;
      if (patch.label !== undefined) m.label = patch.label;
      if (patch.kind !== undefined) m.kind = patch.kind;
      m.source = "user";
      p.markers.sort((a, b) => a.frame - b.frame);
    },
  }),

  "marker.remove": def({
    description: "Remove markers by id, or all markers of the given kinds.",
    params: z.object({ markerIds: z.array(IdSchema).optional(), kinds: z.array(MarkerSchema.shape.kind.unwrap()).optional() }),
    apply(p, { markerIds, kinds }) {
      const before = p.markers.length;
      p.markers = p.markers.filter((m) => !(markerIds?.includes(m.id) || kinds?.includes(m.kind)));
      return { removed: before - p.markers.length };
    },
  }),

  "marker.setBeats": def({
    description: "Replace analysis-generated beat markers with the given frames.",
    params: z.object({
      beats: z.array(z.object({ frame: z.number().int().nonnegative(), strength: z.number().min(0).max(1).optional(), downbeat: z.boolean().optional() })),
      onsets: z.array(z.number().int().nonnegative()).default([]),
    }),
    apply(p, { beats, onsets }) {
      p.markers = p.markers.filter((m) => m.source !== "analysis");
      for (const b of beats)
        p.markers.push(MarkerSchema.parse({ id: newId("mk"), frame: b.frame, kind: b.downbeat ? "downbeat" : "beat", source: "analysis", strength: b.strength }));
      for (const f of onsets) p.markers.push(MarkerSchema.parse({ id: newId("mk"), frame: f, kind: "onset", source: "analysis" }));
      p.markers.sort((a, b) => a.frame - b.frame);
      return { beats: beats.length, onsets: onsets.length };
    },
  }),

  // ------------------------------------------------------------ 3D scenes

  "scene.create": def({
    description: "Create a 3D scene, optionally from a template.",
    params: z.object({
      name: z.string().min(1).max(120),
      durationFrames: z.number().int().min(1).max(100_000),
      template: z.enum(SCENE_TEMPLATE_IDS as [string, ...string[]]).default("empty"),
      text: z.string().max(200).optional(),
      accentA: HexColor.optional(),
      accentB: HexColor.optional(),
      material: MaterialSchema.shape.preset.unwrap().optional(),
      modelAssetId: IdSchema.optional(),
      particles: z.boolean().optional(),
      fog: z.number().min(0).max(1).optional(),
    }),
    apply(p, { template, ...params }) {
      if (params.modelAssetId) {
        const a = findAsset(p as Project, params.modelAssetId);
        if (!a || a.kind !== "model") fail("missing_asset", `Model asset ${params.modelAssetId} not found`);
      }
      const scene = buildSceneFromTemplate(template, params);
      p.scenes.push(scene);
      return { sceneId: scene.id, objectIds: scene.objects.map((o) => ({ id: o.id, name: o.name, kind: o.kind })) };
    },
  }),

  "scene.update": def({
    description: "Update scene name, duration, world, render settings or the active camera.",
    params: z.object({
      sceneId: IdSchema,
      name: z.string().min(1).max(120).optional(),
      durationFrames: z.number().int().min(1).max(100_000).optional(),
      activeCameraId: IdSchema.optional(),
      world: patchSchema(SceneSchema.shape.world.unwrap() as z.ZodObject).optional(),
      render: patchSchema(SceneSchema.shape.render.unwrap() as z.ZodObject).optional(),
    }),
    apply(p, { sceneId, world, render, ...rest }) {
      const s = p.scenes.find((s) => s.id === sceneId);
      if (!s) fail("not_found", `Scene ${sceneId} not found`);
      if (rest.activeCameraId && !s.objects.some((o) => o.id === rest.activeCameraId && o.kind === "camera"))
        fail("invalid_params", `${rest.activeCameraId} is not a camera in this scene`);
      if (rest.name) s.name = rest.name;
      if (rest.durationFrames) s.durationFrames = rest.durationFrames;
      if (rest.activeCameraId) s.activeCameraId = rest.activeCameraId;
      if (world) Object.assign(s.world, world);
      if (render) Object.assign(s.render, render);
    },
  }),

  "scene.remove": def({
    description: "Delete a scene. Fails while clips reference it unless force is set.",
    params: z.object({ sceneId: IdSchema, force: z.boolean().default(false) }),
    apply(p, { sceneId, force }) {
      const used = p.tracks.flatMap((t) => t.clips).filter((c) => c.type === "scene" && c.sceneId === sceneId);
      if (used.length && !force) fail("conflict", `Scene is used by ${used.length} clip(s)`);
      for (const t of p.tracks) t.clips = t.clips.filter((c) => !(c.type === "scene" && c.sceneId === sceneId));
      p.scenes = p.scenes.filter((s) => s.id !== sceneId);
    },
  }),

  "scene.addObject": def({
    description: "Add an object (mesh, text, camera, light, model, particles) to a scene.",
    params: z.object({ sceneId: IdSchema, object: SceneObjectSchema.omit({ id: true }).partial().required({ kind: true }) }),
    apply(p, { sceneId, object }) {
      const s = p.scenes.find((s) => s.id === sceneId);
      if (!s) fail("not_found", `Scene ${sceneId} not found`);
      const o = makeSceneObject({ name: object.name ?? object.kind, ...object } as Parameters<typeof makeSceneObject>[0]);
      if (o.kind === "mesh" && !o.mesh) o.mesh = { primitive: "cube", size: 1, smooth: true };
      if (o.kind === "text" && !o.text) fail("invalid_params", "Text objects need text.body");
      if (o.kind === "camera" && !o.camera) o.camera = { focalLength: 50, dof: false, focusDistance: 5, fStop: 2.8 };
      if (o.kind === "light" && !o.light) o.light = { type: "area", color: "#ffffff", energy: 500, size: 1 };
      if (o.kind === "particles" && !o.particles) o.particles = { count: 400, size: 0.03, color: "#ffffff", emission: 5, area: [6, 6, 4], drift: 0.5, seed: 1 };
      if (o.kind === "model") {
        const a = o.model && findAsset(p as Project, o.model.assetId);
        if (!a || a.kind !== "model") fail("missing_asset", "Model objects need model.assetId of an imported 3D asset");
      }
      s.objects.push(o);
      if (o.kind === "camera" && !s.activeCameraId) s.activeCameraId = o.id;
      return { objectId: o.id };
    },
  }),

  "scene.updateObject": def({
    description: "Update an object's transform, material or kind-specific settings.",
    params: z.object({ sceneId: IdSchema, objectId: IdSchema, patch: patchSchema(SceneObjectSchema.omit({ id: true, kind: true, animation: true }), { deep: true }) }),
    apply(p, { sceneId, objectId, patch }) {
      const s = p.scenes.find((s) => s.id === sceneId);
      const o = s?.objects.find((o) => o.id === objectId);
      if (!s || !o) fail("not_found", `Object ${objectId} not found in scene ${sceneId}`);
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        const cur = (o as Record<string, unknown>)[k];
        if (cur && typeof cur === "object" && !Array.isArray(cur) && typeof v === "object" && !Array.isArray(v)) Object.assign(cur, v);
        else (o as Record<string, unknown>)[k] = v;
      }
      SceneObjectSchema.parse(JSON.parse(JSON.stringify(o)));
    },
  }),

  "scene.removeObject": def({
    description: "Delete an object from a scene.",
    params: z.object({ sceneId: IdSchema, objectId: IdSchema }),
    apply(p, { sceneId, objectId }) {
      const s = p.scenes.find((s) => s.id === sceneId);
      if (!s) fail("not_found", `Scene ${sceneId} not found`);
      s.objects = s.objects.filter((o) => o.id !== objectId);
      if (s.activeCameraId === objectId) s.activeCameraId = s.objects.find((o) => o.kind === "camera")?.id;
    },
  }),

  "scene.animate": def({
    description: "Replace the keyframes of one animated property on a scene object (frames are scene-relative).",
    params: z.object({
      sceneId: IdSchema,
      objectId: IdSchema,
      property: z.enum(SCENE_ANIM_PROPERTIES),
      keyframes: z.array(SceneKeyframeSchema),
    }),
    apply(p, { sceneId, objectId, property, keyframes }) {
      const s = p.scenes.find((s) => s.id === sceneId);
      const o = s?.objects.find((o) => o.id === objectId);
      if (!s || !o) fail("not_found", `Object ${objectId} not found in scene ${sceneId}`);
      const vec = property === "location" || property === "rotation" || property === "scale";
      for (const k of keyframes) {
        if (vec && k.value.length !== 3) fail("invalid_params", `${property} keyframes need 3 values`);
        if (!vec && k.value.length !== 1) fail("invalid_params", `${property} keyframes need 1 value`);
        if (k.frame > s.durationFrames) fail("invalid_params", `Keyframe ${k.frame} is beyond the scene length ${s.durationFrames}`);
      }
      if ((property === "focalLength" || property === "focusDistance") && o.kind !== "camera") fail("invalid_params", `${property} only applies to cameras`);
      if (property === "energy" && o.kind !== "light") fail("invalid_params", "energy only applies to lights");
      o.animation = o.animation.filter((a) => a.property !== property);
      if (keyframes.length) o.animation.push({ property, keyframes: [...keyframes].sort((a, b) => a.frame - b.frame) });
    },
  }),

  // ------------------------------------------------------------ AI bookkeeping

  "ai.savePlan": def({
    description: "Store or update an AI edit plan.",
    params: z.intersection(patchSchema(AiPlanSchema), z.object({ brief: z.string() })),
    apply(p, plan) {
      const existing = plan.id ? p.ai.plans.find((x) => x.id === plan.id) : undefined;
      if (existing) {
        Object.assign(existing, plan);
        return { planId: existing.id };
      }
      const full = AiPlanSchema.parse({ id: newId("plan"), createdAt: new Date().toISOString(), ...plan });
      p.ai.plans.push(full);
      if (p.ai.plans.length > 50) p.ai.plans.splice(0, p.ai.plans.length - 50);
      return { planId: full.id };
    },
  }),
} as const;

export type CommandName = keyof typeof COMMANDS;
export const COMMAND_NAMES = Object.keys(COMMANDS) as CommandName[];
export type CommandParams<N extends CommandName> = z.input<(typeof COMMANDS)[N]["params"]>;
export type CommandResult<N extends CommandName> = ReturnType<(typeof COMMANDS)[N]["apply"]>;

export interface CommandOutcome<R = unknown> {
  project: Project;
  result: R;
  changed: boolean;
}

/**
 * Validate params and apply a command immutably. Throws MantagliError (or a
 * ZodError) without touching the input project on failure.
 */
/** Run another command inside a command's draft (composite commands); params are validated. */
function sub<N extends CommandName>(p: D, name: N, params: CommandParams<N>): CommandResult<N> {
  const cmd = COMMANDS[name] as unknown as CommandDef<z.ZodType, unknown>;
  return cmd.apply(p, cmd.params.parse(params)) as CommandResult<N>;
}

export function applyCommand<N extends CommandName>(project: Project, name: N, params: CommandParams<N>): CommandOutcome<CommandResult<N>> {
  const cmd = COMMANDS[name] as unknown as CommandDef<z.ZodType, unknown>;
  if (!cmd) fail("unsupported", `Unknown command "${name}"`);
  const parsed = cmd.params.parse(params);
  let result: unknown;
  const next = produce(project, (draft) => {
    result = cmd.apply(draft, parsed);
  });
  const changed = next !== project;
  const stamped = changed
    ? produce(next, (d) => {
        d.modifiedAt = new Date().toISOString();
      })
    : next;
  return { project: stamped, result: result as CommandResult<N>, changed };
}
