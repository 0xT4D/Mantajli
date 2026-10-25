import { z } from "zod";
import { EFFECT_TYPES, TEXT_ANIMATIONS, TRANSITION_TYPES } from "./effects.js";

export const SCHEMA_VERSION = 1;

export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "invalid id");
export const RationalSchema = z.object({ num: z.number().int().positive(), den: z.number().int().positive() });
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb");

// ---------------------------------------------------------------- assets

export const ASSET_KINDS = ["video", "audio", "image", "model", "font", "lut"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const MediaMetaSchema = z.object({
  formatName: z.string().optional(),
  duration: z.number().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: RationalSchema.optional(),
  variableFrameRate: z.boolean().optional(),
  videoCodec: z.string().optional(),
  pixFmt: z.string().optional(),
  rotation: z.number().optional(),
  hasVideo: z.boolean().default(false),
  hasAudio: z.boolean().default(false),
  audioCodec: z.string().optional(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  bitRate: z.number().nonnegative().optional(),
});
export type MediaMeta = z.infer<typeof MediaMetaSchema>;

export const BeatAnalysisSchema = z.object({
  bpm: z.number().nonnegative(),
  /** Beat times in seconds relative to the start of the asset. */
  times: z.array(z.number().nonnegative()),
  /** Onset strengths (0–1) aligned with `times`. */
  strengths: z.array(z.number()).default([]),
  /** Bar starts (assumes 4/4), seconds. */
  downbeats: z.array(z.number().nonnegative()).default([]),
  /** Strong transient (onset) times in seconds. */
  onsets: z.array(z.number().nonnegative()).default([]),
  /** Song structure: section starts (seconds) labelled intro/build/drop/breakdown/change/outro, with relative energy 0-1. */
  sections: z.array(z.object({ time: z.number().nonnegative(), label: z.string(), energy: z.number().min(0).max(1) })).default([]),
  confidence: z.number().min(0).max(1),
  analyzedAt: z.string(),
});
export type BeatAnalysis = z.infer<typeof BeatAnalysisSchema>;

export const AssetSchema = z.object({
  id: IdSchema,
  kind: z.enum(ASSET_KINDS),
  name: z.string(),
  /** Absolute path of the original file (never modified). */
  path: z.string(),
  /** Path relative to the project folder, used for relinking moved projects. */
  relativePath: z.string().optional(),
  size: z.number().nonnegative(),
  /** Fast content fingerprint for duplicate detection. */
  hash: z.string(),
  importedAt: z.string(),
  status: z.enum(["ok", "missing", "error"]).default("ok"),
  error: z.string().optional(),
  meta: MediaMetaSchema.default({ hasVideo: false, hasAudio: false }),
  /** Generated files, relative to the project folder. */
  derived: z
    .object({
      thumbnail: z.string().optional(),
      proxy: z.string().optional(),
      waveform: z.string().optional(),
      filmstrip: z.string().optional(),
    })
    .default({}),
  analysis: z.object({ beats: BeatAnalysisSchema.optional() }).default({}),
  tags: z.array(z.string()).default([]),
  favorite: z.boolean().default(false),
  collection: z.string().optional(),
});
export type Asset = z.infer<typeof AssetSchema>;

// ---------------------------------------------------------------- clips

/**
 * Segment easings. expo* are the "snap and settle" curves (fast start, long
 * exponential settle); back* overshoot slightly before settling.
 */
export const EASINGS = ["linear", "easeIn", "easeOut", "easeInOut", "hold", "expoIn", "expoOut", "expoInOut", "backIn", "backOut"] as const;
export type Easing = (typeof EASINGS)[number];

export const KEYFRAME_PROPERTIES = ["opacity", "x", "y", "scale", "rotation", "volume", "speed"] as const;
export type KeyframeProperty = (typeof KEYFRAME_PROPERTIES)[number];

export const KeyframeSchema = z.object({
  /** Frame relative to the clip start. */
  frame: z.number().int().nonnegative(),
  value: z.number(),
  easing: z.enum(EASINGS).default("easeInOut"),
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const TransformSchema = z.object({
  /** Offset of the clip centre from the frame centre, in project pixels. */
  x: z.number().default(0),
  y: z.number().default(0),
  /** 1 = sized by `fit`. */
  scale: z.number().min(0.01).max(20).default(1),
  rotation: z.number().min(-3600).max(3600).default(0),
  fit: z.enum(["fill", "fit", "stretch"]).default("fill"),
  crop: z
    .object({
      left: z.number().min(0).max(0.45).default(0),
      right: z.number().min(0).max(0.45).default(0),
      top: z.number().min(0).max(0.45).default(0),
      bottom: z.number().min(0).max(0.45).default(0),
    })
    .default({ left: 0, right: 0, top: 0, bottom: 0 }),
});
export type Transform = z.infer<typeof TransformSchema>;

export const EffectSchema = z.object({
  id: IdSchema,
  type: z.enum(EFFECT_TYPES as [string, ...string[]]),
  enabled: z.boolean().default(true),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
});
export type Effect = z.infer<typeof EffectSchema>;

export const TransitionSchema = z.object({
  type: z.enum(TRANSITION_TYPES as [string, ...string[]]),
  duration: z.number().int().min(1).max(600),
  /** Override of the transition's own easing (progress curve). */
  easing: z.enum(EASINGS).optional(),
  /** Strength of motion blur, zoom and glitch (1 = default). */
  intensity: z.number().min(0).max(2).optional(),
});
export type Transition = z.infer<typeof TransitionSchema>;

/** Layer blend modes (FFmpeg blend filter / canvas globalCompositeOperation). */
export const BLEND_MODES = ["normal", "screen", "add", "multiply", "overlay", "softLight", "lighten", "darken", "difference"] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

const ClipBase = {
  id: IdSchema,
  name: z.string().default(""),
  /** Timeline start, in project frames. */
  start: z.number().int().nonnegative(),
  /** Timeline duration, in project frames. */
  duration: z.number().int().positive(),
  opacity: z.number().min(0).max(1).default(1),
  /** How the layer combines with the layers below it. */
  blendMode: z.enum(BLEND_MODES).default("normal"),
  transform: TransformSchema.default(TransformSchema.parse({})),
  /** Fade from/to transparent (video) and silence (audio), in frames. */
  fadeIn: z.number().int().nonnegative().default(0),
  fadeOut: z.number().int().nonnegative().default(0),
  effects: z.array(EffectSchema).default([]),
  keyframes: z.partialRecord(z.enum(KEYFRAME_PROPERTIES), z.array(KeyframeSchema)).default({}),
  transitionIn: TransitionSchema.nullable().default(null),
  color: z.string().optional(),
};

export const MediaClipSchema = z.object({
  ...ClipBase,
  type: z.literal("media"),
  assetId: IdSchema,
  /** Offset into the source in seconds. */
  sourceIn: z.number().nonnegative().default(0),
  speed: z.number().min(0.1).max(16).default(1),
  volumeDb: z.number().min(-60).max(24).default(0),
  audioEnabled: z.boolean().default(true),
  /** Play the source range [sourceIn, sourceIn + span) backwards (video and audio). */
  reverse: z.boolean().default(false),
  /** Hold the frame at sourceIn for the whole clip (freeze frame; silent). */
  freeze: z.boolean().default(false),
});
export type MediaClip = z.infer<typeof MediaClipSchema>;

export const TextStyleSchema = z.object({
  fontFamily: z.string().default("Arial"),
  /** Imported font asset; overrides fontFamily when set. */
  fontAssetId: z.string().optional(),
  bold: z.boolean().default(true),
  fontSize: z.number().min(4).max(1000).default(96),
  color: HexColor.default("#ffffff"),
  align: z.enum(["left", "center", "right"]).default("center"),
  strokeWidth: z.number().min(0).max(40).default(0),
  strokeColor: HexColor.default("#000000"),
  shadow: z.boolean().default(true),
  shadowColor: HexColor.default("#000000"),
  box: z.boolean().default(false),
  boxColor: HexColor.default("#000000"),
  boxOpacity: z.number().min(0).max(1).default(0.5),
});
export type TextStyle = z.infer<typeof TextStyleSchema>;

export const TextClipSchema = z.object({
  ...ClipBase,
  type: z.literal("text"),
  text: z.string().max(2000),
  style: TextStyleSchema.default(TextStyleSchema.parse({})),
  animation: z
    .object({
      in: z.enum(TEXT_ANIMATIONS).default("fade"),
      out: z.enum(TEXT_ANIMATIONS).default("fade"),
      /** Length of the in/out animation, in frames. */
      duration: z.number().int().min(1).max(300).default(12),
    })
    .default({ in: "fade", out: "fade", duration: 12 }),
});
export type TextClip = z.infer<typeof TextClipSchema>;

export const SceneClipSchema = z.object({
  ...ClipBase,
  type: z.literal("scene"),
  sceneId: IdSchema,
  /** Offset into the rendered scene, in seconds. */
  sourceIn: z.number().nonnegative().default(0),
});
export type SceneClip = z.infer<typeof SceneClipSchema>;

export const ColorClipSchema = z.object({
  ...ClipBase,
  type: z.literal("color"),
  fill: HexColor.default("#000000"),
});
export type ColorClip = z.infer<typeof ColorClipSchema>;

/**
 * Adjustment layer: no content of its own. Its effects, opacity, masks, blend
 * mode and motion apply to everything composited below it while it is on the
 * timeline (a whole-frame grade, lens/CRT finish, or camera shake).
 */
export const AdjustmentClipSchema = z.object({
  ...ClipBase,
  type: z.literal("adjustment"),
});
export type AdjustmentClip = z.infer<typeof AdjustmentClipSchema>;

export const ClipSchema = z.discriminatedUnion("type", [MediaClipSchema, TextClipSchema, SceneClipSchema, ColorClipSchema, AdjustmentClipSchema]);
export type Clip = z.infer<typeof ClipSchema>;
export type ClipType = Clip["type"];

// ---------------------------------------------------------------- tracks

export const TRACK_KINDS = ["video", "text", "scene", "audio"] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];

export const TrackSchema = z.object({
  id: IdSchema,
  name: z.string(),
  kind: z.enum(TRACK_KINDS),
  muted: z.boolean().default(false),
  solo: z.boolean().default(false),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
  volumeDb: z.number().min(-60).max(12).default(0),
  /** Music tracks are the default source for beat sync. */
  role: z.enum(["general", "music", "sfx", "dialogue"]).default("general"),
  clips: z.array(ClipSchema).default([]),
});
export type Track = z.infer<typeof TrackSchema>;

// ---------------------------------------------------------------- markers

export const MarkerSchema = z.object({
  id: IdSchema,
  frame: z.number().int().nonnegative(),
  label: z.string().default(""),
  kind: z.enum(["cue", "beat", "downbeat", "section", "onset"]).default("cue"),
  color: HexColor.optional(),
  source: z.enum(["user", "analysis", "ai"]).default("user"),
  strength: z.number().min(0).max(1).optional(),
});
export type Marker = z.infer<typeof MarkerSchema>;

// ---------------------------------------------------------------- 3D scenes

export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;

export const MATERIAL_PRESETS = ["custom", "chrome", "gold", "glass", "matte", "plastic", "neon", "carPaint"] as const;

export const MaterialSchema = z.object({
  preset: z.enum(MATERIAL_PRESETS).default("custom"),
  baseColor: HexColor.default("#cccccc"),
  metallic: z.number().min(0).max(1).default(0),
  roughness: z.number().min(0).max(1).default(0.5),
  emissionColor: HexColor.default("#000000"),
  emissionStrength: z.number().min(0).max(100).default(0),
  transmission: z.number().min(0).max(1).default(0),
  /**
   * Procedural pattern. "grid" draws glowing lines (emission colour/strength)
   * on the base colour every `patternScale` metres (synthwave floors, stages);
   * "smoke" makes the emission billow like smoke/clouds (features about
   * `patternScale` metres across) — smoky backdrops.
   */
  pattern: z.enum(["none", "grid", "smoke"]).default("none"),
  patternScale: z.number().min(0.01).max(100).default(1),
  /** Line width as a fraction of a cell. */
  patternLineWidth: z.number().min(0.001).max(0.5).default(0.04),
});
export type Material = z.infer<typeof MaterialSchema>;

/** pathProgress (0 = first point, 1 = last) moves an object along its `path`. */
export const SCENE_ANIM_PROPERTIES = ["location", "rotation", "scale", "focalLength", "energy", "focusDistance", "pathProgress"] as const;
export type SceneAnimProperty = (typeof SCENE_ANIM_PROPERTIES)[number];

export const SceneKeyframeSchema = z.object({
  frame: z.number().int().nonnegative(),
  /** 3 values for location/rotation(deg)/scale, 1 value otherwise. */
  value: z.array(z.number()).min(1).max(3),
  easing: z.enum(EASINGS).default("easeInOut"),
});
export type SceneKeyframe = z.infer<typeof SceneKeyframeSchema>;

export const SceneAnimTrackSchema = z.object({
  property: z.enum(SCENE_ANIM_PROPERTIES),
  keyframes: z.array(SceneKeyframeSchema),
});

export const MESH_PRIMITIVES = ["cube", "sphere", "plane", "cylinder", "cone", "torus", "monkey", "roundedCube", "coin", "crystal", "icosphere"] as const;

export const SCATTER_DISTRIBUTIONS = ["box", "pile", "disc", "ring", "grid"] as const;

export const SceneObjectSchema = z.object({
  id: IdSchema,
  name: z.string(),
  kind: z.enum(["mesh", "text", "camera", "light", "model", "particles", "media", "scatter"]),
  visible: z.boolean().default(true),
  location: Vec3.default([0, 0, 0]),
  /** Euler XYZ in degrees. */
  rotation: Vec3.default([0, 0, 0]),
  scale: Vec3.default([1, 1, 1]),
  material: MaterialSchema.optional(),
  mesh: z.object({ primitive: z.enum(MESH_PRIMITIVES), size: z.number().positive().default(1), smooth: z.boolean().default(true) }).optional(),
  text: z
    .object({
      body: z.string().max(500),
      fontAssetId: z.string().optional(),
      size: z.number().positive().default(1),
      extrude: z.number().min(0).max(5).default(0.1),
      bevel: z.number().min(0).max(1).default(0.02),
      align: z.enum(["left", "center", "right"]).default("center"),
      letterSpacing: z.number().min(0).max(5).default(1),
      /** Material of the extruded sides and bevel (two-tone type: e.g. silver face, gold edges). */
      sideMaterial: z.lazy(() => MaterialSchema).optional(),
    })
    .optional(),
  camera: z
    .object({
      focalLength: z.number().min(5).max(500).default(35),
      dof: z.boolean().default(false),
      focusDistance: z.number().min(0.01).default(5),
      fStop: z.number().min(0.5).max(64).default(2.8),
      /** Keep the camera pointed at this object. */
      trackTargetId: z.string().optional(),
      /** Handheld shake: angular amplitude in degrees (0 = locked off). */
      shake: z.number().min(0).max(10).default(0),
      /** Shake speed in Hz. */
      shakeHz: z.number().min(0.1).max(20).default(1.2),
    })
    .optional(),
  light: z
    .object({
      type: z.enum(["point", "sun", "area", "spot"]).default("area"),
      color: HexColor.default("#ffffff"),
      /** Watts for point/area/spot, irradiance for sun. */
      energy: z.number().min(0).max(1e6).default(500),
      size: z.number().min(0).default(1),
      /** Spot cone angle (degrees) and edge softness (0–1). */
      spotSize: z.number().min(1).max(180).default(45),
      spotBlend: z.number().min(0).max(1).default(0.15),
    })
    .optional(),
  model: z.object({ assetId: IdSchema }).optional(),
  /**
   * Image or video on a plane (screens, logos, portals). Width in metres; the
   * height follows the media's aspect. emission > 0 makes it a glowing screen
   * (unlit), 0 lights it like a print. Video advances one frame per scene frame
   * starting at sourceIn seconds.
   */
  media: z
    .object({
      assetId: IdSchema,
      width: z.number().positive().max(1000).default(2),
      emission: z.number().min(0).max(50).default(1),
      sourceIn: z.number().min(0).default(0),
      loop: z.boolean().default(true),
    })
    .optional(),
  /**
   * Instances of a primitive (or a model) scattered with a seeded random layout:
   * coin piles, crystal clusters, rows of seats, floating debris.
   */
  scatter: z
    .object({
      primitive: z.enum(MESH_PRIMITIVES).default("coin"),
      modelAssetId: IdSchema.optional(),
      count: z.number().int().min(1).max(20000).default(300),
      distribution: z.enum(SCATTER_DISTRIBUTIONS).default("pile"),
      /** Half-extents (box/grid), radius in x (disc/ring/pile) and height in z (pile). */
      area: Vec3.default([2, 2, 1]),
      size: z.number().positive().max(100).default(0.2),
      sizeJitter: z.number().min(0).max(1).default(0.25),
      /** Random rotation amount (0 = aligned, 1 = fully random). */
      rotationJitter: z.number().min(0).max(1).default(1),
      seed: z.number().int().default(1),
    })
    .optional(),
  /**
   * Smooth spline through `points` (scene coordinates). Animate pathProgress
   * (0..1) to move along it; the object's own location is added as an offset.
   * Cameras keep looking at their target (or their own rotation) unless
   * followTangent turns them along the path.
   */
  path: z
    .object({
      points: z.array(Vec3).min(2).max(64),
      closed: z.boolean().default(false),
      followTangent: z.boolean().default(false),
    })
    .optional(),
  particles: z
    .object({
      count: z.number().int().min(1).max(5000).default(400),
      size: z.number().positive().default(0.03),
      color: HexColor.default("#ffffff"),
      emission: z.number().min(0).max(100).default(5),
      /** Box the particles float in (half-extents). */
      area: Vec3.default([6, 6, 4]),
      drift: z.number().min(0).max(10).default(0.5),
      seed: z.number().int().default(1),
    })
    .optional(),
  animation: z.array(SceneAnimTrackSchema).default([]),
});
export type SceneObject = z.infer<typeof SceneObjectSchema>;

export const SceneSchema = z.object({
  id: IdSchema,
  name: z.string(),
  /** Length of the scene in project frames. */
  durationFrames: z.number().int().min(1).max(100_000),
  template: z.string().optional(),
  activeCameraId: z.string().optional(),
  world: z
    .object({
      color: HexColor.default("#05050a"),
      strength: z.number().min(0).max(100).default(1),
      /** Volumetric fog density (0 = off). */
      fog: z.number().min(0).max(1).default(0),
      /**
       * Studio reflection band strength. Invisible to the camera but seen by
       * reflections, so metallic and chrome surfaces read well (0 = off).
       */
      reflections: z.number().min(0).max(20).default(0),
    })
    .default({ color: "#05050a", strength: 1, fog: 0, reflections: 0 }),
  render: z
    .object({
      engine: z.enum(["eevee", "cycles", "workbench"]).default("eevee"),
      samples: z.number().int().min(1).max(4096).default(64),
      motionBlur: z.boolean().default(true),
      shutter: z.number().min(0.01).max(2).default(0.5),
      bloom: z.boolean().default(true),
      denoise: z.boolean().default(true),
      transparent: z.boolean().default(false),
      viewTransform: z.enum(["AgX", "Filmic", "Standard"]).default("AgX"),
      look: z.enum(["None", "Punchy", "High Contrast", "Base Contrast", "Medium Contrast"]).default("None"),
    })
    .default({
      engine: "eevee",
      samples: 64,
      motionBlur: true,
      shutter: 0.5,
      bloom: true,
      denoise: true,
      transparent: false,
      viewTransform: "AgX",
      look: "None",
    }),
  objects: z.array(SceneObjectSchema).default([]),
});
export type Scene = z.infer<typeof SceneSchema>;

// ---------------------------------------------------------------- settings / export / AI

export const SettingsSchema = z.object({
  width: z.number().int().min(16).max(8192),
  height: z.number().int().min(16).max(8192),
  fps: RationalSchema,
  sampleRate: z.number().int().default(48000),
  background: HexColor.default("#000000"),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const EXPORT_PRESETS = ["reel1080", "square1080", "landscape1080", "landscape4k", "reel4k", "master"] as const;

export const ExportSettingsSchema = z.object({
  preset: z.enum(EXPORT_PRESETS).default("reel1080"),
  codec: z.enum(["h264", "h265", "prores"]).default("h264"),
  /** x264/x265 CRF (lower is better). */
  crf: z.number().int().min(0).max(51).default(18),
  encoderPreset: z.enum(["ultrafast", "veryfast", "fast", "medium", "slow"]).default("medium"),
  audioBitrateK: z.number().int().min(64).max(512).default(256),
  /** Integrated loudness target of the export (EBU R128), or null to leave levels as mixed. */
  loudnessLufs: z.number().min(-30).max(-8).nullable().default(null),
  /** Override output resolution (defaults to project settings). */
  width: z.number().int().optional(),
  height: z.number().int().optional(),
});
export type ExportSettings = z.infer<typeof ExportSettingsSchema>;

/** Automatic mix: music tracks duck under dialogue (and optionally SFX) clips. */
export const MixSettingsSchema = z.object({
  ducking: z
    .object({
      enabled: z.boolean().default(false),
      /** How far music drops, in dB (positive). */
      amountDb: z.number().min(0).max(40).default(12),
      attackFrames: z.number().int().min(0).max(120).default(6),
      releaseFrames: z.number().int().min(0).max(240).default(15),
      /** Track roles whose clips trigger ducking. */
      triggers: z.array(z.enum(["dialogue", "sfx"])).min(1).default(["dialogue"]),
    })
    .default({ enabled: false, amountDb: 12, attackFrames: 6, releaseFrames: 15, triggers: ["dialogue"] }),
});
export type MixSettings = z.infer<typeof MixSettingsSchema>;

export const PlanShotSchema = z.object({
  index: z.number().int(),
  description: z.string(),
  startFrame: z.number().int(),
  durationFrames: z.number().int(),
  source: z.string().optional(),
  transition: z.string().optional(),
  notes: z.string().optional(),
});

export const AiPlanSchema = z.object({
  id: IdSchema,
  createdAt: z.string(),
  brief: z.string(),
  summary: z.string().default(""),
  status: z.enum(["draft", "approved", "executing", "done", "failed", "cancelled"]).default("draft"),
  shots: z.array(PlanShotSchema).default([]),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type AiPlan = z.infer<typeof AiPlanSchema>;

/** A look saved by the user: a named, reusable effect stack (alongside the built-in LOOKS). */
export const UserLookSchema = z.object({
  id: IdSchema,
  label: z.string().min(1).max(80),
  description: z.string().max(300).default(""),
  effects: z.array(z.object({ type: z.enum(EFFECT_TYPES as [string, ...string[]]), params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])) })).max(32),
});
export type UserLook = z.infer<typeof UserLookSchema>;

export const OpLogEntrySchema = z.object({
  at: z.string(),
  source: z.enum(["user", "ai", "mcp", "system"]),
  label: z.string(),
});
export type OpLogEntry = z.infer<typeof OpLogEntrySchema>;

export const ProjectSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: IdSchema,
  name: z.string().min(1).max(200),
  createdAt: z.string(),
  modifiedAt: z.string(),
  settings: SettingsSchema,
  assets: z.array(AssetSchema).default([]),
  tracks: z.array(TrackSchema).default([]),
  markers: z.array(MarkerSchema).default([]),
  scenes: z.array(SceneSchema).default([]),
  export: ExportSettingsSchema.default(ExportSettingsSchema.parse({})),
  mix: MixSettingsSchema.default(MixSettingsSchema.parse({})),
  /** Looks saved in this project (effect stacks the user made reusable). */
  looks: z.array(UserLookSchema).default([]),
  ai: z
    .object({
      plans: z.array(AiPlanSchema).default([]),
      log: z.array(OpLogEntrySchema).default([]),
    })
    .default({ plans: [], log: [] }),
});
export type Project = z.infer<typeof ProjectSchema>;

// ---------------------------------------------------------------- patch schemas

export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function stripDefaults(t: z.ZodType, deep: boolean): z.ZodType {
  let cur: z.ZodType = t;
  while (cur instanceof z.ZodDefault || cur instanceof z.ZodPrefault) cur = cur.unwrap() as z.ZodType;
  if (deep && cur instanceof z.ZodObject) return patchSchema(cur, { deep: true });
  return cur;
}

/**
 * Partial "patch" version of an object schema. Unlike `.partial()`, field
 * defaults are removed, so omitted fields stay undefined instead of being
 * reset to their defaults. With `deep`, nested objects become patches too.
 */
export function patchSchema<T extends z.ZodObject>(schema: T, opts: { deep?: boolean } = {}): z.ZodType<DeepPartial<z.output<T>>, DeepPartial<z.input<T>>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(schema.shape)) shape[k] = stripDefaults(v as z.ZodType, !!opts.deep).optional();
  return z.object(shape) as unknown as z.ZodType<DeepPartial<z.output<T>>, DeepPartial<z.input<T>>>;
}
