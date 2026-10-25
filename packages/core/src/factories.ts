import type { z } from "zod";
import { newId } from "./ids.js";
import {
  AdjustmentClipSchema,
  ColorClipSchema,
  MediaClipSchema,
  ProjectSchema,
  SCHEMA_VERSION,
  SceneClipSchema,
  SceneObjectSchema,
  TextClipSchema,
  TrackSchema,
  type AdjustmentClip,
  type Clip,
  type ColorClip,
  type MediaClip,
  type Project,
  type SceneClip,
  type SceneObject,
  type TextClip,
  type Track,
  type TrackKind,
} from "./schema.js";
import type { Rational } from "./time.js";

export const FORMAT_PRESETS = {
  vertical: { label: "Vertical 9:16 (1080×1920)", width: 1080, height: 1920 },
  square: { label: "Square 1:1 (1080×1080)", width: 1080, height: 1080 },
  landscape: { label: "Landscape 16:9 (1920×1080)", width: 1920, height: 1080 },
  landscape4k: { label: "Landscape 4K (3840×2160)", width: 3840, height: 2160 },
  vertical4k: { label: "Vertical 4K (2160×3840)", width: 2160, height: 3840 },
} as const;
export type FormatPreset = keyof typeof FORMAT_PRESETS;

export interface CreateProjectOptions {
  name: string;
  format?: FormatPreset;
  width?: number;
  height?: number;
  fps?: Rational;
}

export function createProject(opts: CreateProjectOptions): Project {
  const fmt = FORMAT_PRESETS[opts.format ?? "vertical"];
  const now = new Date().toISOString();
  return ProjectSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: newId("prj"),
    name: opts.name,
    createdAt: now,
    modifiedAt: now,
    settings: {
      width: opts.width ?? fmt.width,
      height: opts.height ?? fmt.height,
      fps: opts.fps ?? { num: 30, den: 1 },
    },
    tracks: [
      makeTrack("text", "Titles"),
      makeTrack("video", "V2"),
      makeTrack("video", "V1"),
      makeTrack("audio", "Music", { role: "music" }),
      makeTrack("audio", "SFX", { role: "sfx" }),
    ],
    export: {
      preset: opts.format === "square" ? "square1080" : opts.format?.startsWith("landscape") ? "landscape1080" : "reel1080",
    },
  });
}

export function makeTrack(kind: TrackKind, name: string, extra: Partial<Track> = {}): Track {
  return TrackSchema.parse({ id: newId("trk"), name, kind, clips: [], ...extra });
}

type ClipInit<T> = Omit<Partial<T>, "type"> & { start: number; duration: number };

export function makeMediaClip(init: ClipInit<MediaClip> & { assetId: string }): MediaClip {
  return MediaClipSchema.parse({ id: newId("clip"), ...init, type: "media" });
}

export function makeTextClip(init: ClipInit<TextClip> & { text: string }): TextClip {
  return TextClipSchema.parse({ id: newId("clip"), ...init, type: "text" });
}

export function makeSceneClip(init: ClipInit<SceneClip> & { sceneId: string }): SceneClip {
  return SceneClipSchema.parse({ id: newId("clip"), ...init, type: "scene" });
}

export function makeColorClip(init: ClipInit<ColorClip>): ColorClip {
  return ColorClipSchema.parse({ id: newId("clip"), ...init, type: "color" });
}

export function makeAdjustmentClip(init: ClipInit<AdjustmentClip>): AdjustmentClip {
  return AdjustmentClipSchema.parse({ id: newId("clip"), ...init, type: "adjustment" });
}

export type SceneObjectInit = Partial<z.input<typeof SceneObjectSchema>> & Pick<SceneObject, "kind" | "name">;

/** Scene object from partial input; omitted fields (including nested ones) take their schema defaults. */
export function makeSceneObject(init: SceneObjectInit): SceneObject {
  return SceneObjectSchema.parse({ id: newId("obj"), ...init });
}

/** Deep copy of a clip with fresh ids for the clip and its effects. */
export function cloneClip<T extends Clip>(c: T): T {
  // JSON round-trip also works on immer drafts, unlike structuredClone.
  const copy = JSON.parse(JSON.stringify(c)) as T;
  copy.id = newId("clip");
  copy.effects = copy.effects.map((e) => ({ ...e, id: newId("fx") }));
  return copy;
}
