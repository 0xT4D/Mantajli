import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  COMMAND_NAMES,
  EASINGS,
  EFFECTS,
  EFFECT_TYPES,
  FORMAT_PRESETS,
  KEYFRAME_PROPERTIES,
  SPEED_RAMP_PRESETS,
  CAPTION_STYLES,
  RENDER_PRESETS,
  RENDER_PRESET_IDS,
  BLEND_MODES,
  LOOKS,
  MATERIAL_PRESETS,
  MESH_PRIMITIVES,
  SCENE_ANIM_PROPERTIES,
  SCENE_TEMPLATES,
  SCENE_TEMPLATE_IDS,
  TEXT_ANIMATIONS,
  TRACK_KINDS,
  TRANSITIONS,
  TRANSITION_TYPES,
  fail,
  findAsset,
  findClip,
  lookSpec,
  summarizeProject,
  toErrorPayload,
  validateProject,
  type ChangeSource,
  type CommandName,
  type ErrorCategory,
} from "@mantagli/core";
import type { Engine } from "../engine.js";
import { exportOtio, importOtio } from "../interchange/otio.js";
import { exportCaptions, importCaptions } from "../interchange/captions.js";
import { isInside, safeName } from "../util/fsx.js";

/**
 * The AI tool layer. One registry, used by the in-app Claude director and the
 * MCP server. Every tool validates input with zod, performs a whitelisted
 * operation through the engine, and returns structured JSON (or an error with
 * a category). There is no shell or arbitrary-code tool.
 */

export interface ToolContext {
  engine: Engine;
  source: ChangeSource;
  signal?: AbortSignal;
  /** Asked before expensive or destructive operations. Resolve false to deny. */
  approve?: (req: { tool: string; summary: string }) => Promise<boolean>;
}

export interface ToolImage {
  /** PNG file on disk. */
  path: string;
  caption: string;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: { category: ErrorCategory; message: string };
  images?: ToolImage[];
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  input: S;
  /** Changes the project (counts toward the AI change set). */
  mutates: boolean;
  run(ctx: ToolContext, input: z.output<S>): Promise<{ data: unknown; images?: ToolImage[] }>;
}

function tool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

const Frame = z.number().int().nonnegative();
const Id = z.string().min(1).max(64);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

const session = (ctx: ToolContext) => ctx.engine.requireSession();
/** Longest a single tool call blocks (MCP clients usually time out at 60 s). */
const MAX_TOOL_WAIT_S = 45;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const label = (tool: string) => `AI: ${tool}`;

/** Folders the AI may import media from. */
function mediaRoots(ctx: ToolContext): string[] {
  const home = os.homedir();
  const roots = ["Videos", "Music", "Pictures", "Downloads", "Desktop", "Documents"].map((d) => path.join(home, d));
  const s = ctx.engine.session;
  if (s) roots.push(path.dirname(s.dir), s.dir);
  return roots;
}

async function requireApproval(ctx: ToolContext, toolName: string, summary: string) {
  if (!ctx.approve) return;
  if (!(await ctx.approve({ tool: toolName, summary }))) fail("permission_denied", `The user declined: ${summary}`);
}

export const TOOLS: ToolDef[] = [
  // ------------------------------------------------------------ project
  tool({
    name: "project_get_state",
    description:
      "Compact summary of the open project: settings, assets (ids, durations, sizes, BPM), tracks with clips (frame positions), 3D scenes, beat/onset marker frames and validation issues. Call this first and after large edits. All timeline positions are integer frames at the project fps; sourceIn values are seconds.",
    input: z.object({ includeValidation: z.boolean().default(true) }),
    mutates: false,
    async run(ctx, i) {
      return { data: summarizeProject(session(ctx).project, { includeValidation: i.includeValidation }) };
    },
  }),
  tool({
    name: "project_get_settings",
    description: "Project resolution, frame rate, export settings and file location.",
    input: z.object({}),
    mutates: false,
    async run(ctx) {
      const s = session(ctx);
      return { data: { dir: s.dir, name: s.project.name, settings: s.project.settings, export: s.project.export, saveState: s.saveState } };
    },
  }),
  tool({
    name: "project_create",
    description: `Create and open a new project. Formats: ${Object.entries(FORMAT_PRESETS).map(([k, v]) => `${k} (${v.label})`).join(", ")}.`,
    input: z.object({ name: z.string().min(1).max(120), format: z.enum(Object.keys(FORMAT_PRESETS) as [keyof typeof FORMAT_PRESETS]).default("vertical"), fps: z.enum(["24", "25", "30", "50", "60"]).default("30") }),
    mutates: true,
    async run(ctx, i) {
      const s = await ctx.engine.createProject({ name: i.name, format: i.format, fps: { num: Number(i.fps), den: 1 } });
      return { data: { dir: s.dir, projectId: s.project.id } };
    },
  }),
  tool({
    name: "project_open",
    description: "Open an existing Mantagli project folder (*.mantagli). Closes the current project after saving it.",
    input: z.object({ path: z.string().min(1) }),
    mutates: false,
    async run(ctx, i) {
      const s = await ctx.engine.openProject(i.path);
      return { data: { dir: s.dir, name: s.project.name, recoveredFrom: s.recoveredFrom } };
    },
  }),
  tool({
    name: "project_update_settings",
    description: "Change project resolution, frame rate or background colour. Changing fps re-times every frame value.",
    input: z.object({ width: z.number().int().min(16).max(8192).optional(), height: z.number().int().min(16).max(8192).optional(), fps: z.number().int().min(1).max(120).optional(), background: Hex.optional() }),
    mutates: true,
    async run(ctx, i) {
      session(ctx).dispatch("project.setSettings", { width: i.width, height: i.height, background: i.background, fps: i.fps ? { num: i.fps, den: 1 } : undefined }, ctx.source, label("settings"));
      return { data: session(ctx).project.settings };
    },
  }),
  tool({
    name: "project_save",
    description: "Save the project to disk now and write a backup snapshot. (The project also autosaves.)",
    input: z.object({}),
    mutates: false,
    async run(ctx) {
      await session(ctx).save({ backup: true });
      return { data: { saved: true, file: session(ctx).file } };
    },
  }),
  tool({
    name: "project_validate",
    description: "Structural validation: overlaps, missing media, bad references, source overruns.",
    input: z.object({}),
    mutates: false,
    async run(ctx) {
      const issues = validateProject(session(ctx).project);
      return { data: { ok: !issues.some((x) => x.severity === "error"), issues } };
    },
  }),
  tool({
    name: "project_undo",
    description: "Undo the last change (any source).",
    input: z.object({}),
    mutates: true,
    async run(ctx) {
      const r = session(ctx).undo();
      return { data: r ? { undone: r.label } : { undone: null, note: "Nothing to undo" } };
    },
  }),
  tool({
    name: "project_redo",
    description: "Redo the last undone change.",
    input: z.object({}),
    mutates: true,
    async run(ctx) {
      const r = session(ctx).redo();
      return { data: r ? { redone: r.label } : { redone: null, note: "Nothing to redo" } };
    },
  }),
  tool({
    name: "capabilities",
    description: "Lists every supported effect (with parameter ranges), transition, look, text animation, 3D scene template, material preset and keyframe property. Use it to avoid unsupported operations.",
    input: z.object({}),
    mutates: false,
    async run() {
      return {
        data: {
          effects: EFFECTS.map((e) => ({ type: e.type, description: e.description, params: e.params })),
          transitions: TRANSITIONS.map((t) => ({ type: t.type, description: t.description })),
          looks: LOOKS.map((l) => ({ id: l.id, description: l.description })),
          textAnimations: TEXT_ANIMATIONS,
          speedRampPresets: SPEED_RAMP_PRESETS,
          renderPresets: RENDER_PRESETS.map((r) => ({ id: r.id, description: r.description })),
          blendModes: BLEND_MODES,
          sceneTemplates: SCENE_TEMPLATES.map((t) => ({ id: t.id, description: t.description })),
          materialPresets: MATERIAL_PRESETS,
          meshPrimitives: MESH_PRIMITIVES,
          clipKeyframeProperties: KEYFRAME_PROPERTIES,
          sceneAnimProperties: SCENE_ANIM_PROPERTIES,
          exportPresets: ["reel1080", "square1080", "landscape1080", "landscape4k", "reel4k", "master"],
          notes: [
            "Track index 0 is the top layer. Clips on one track never overlap (overwrite mode trims/splits what is underneath).",
            "A transition belongs to the incoming clip and plays over its first N frames; the previous clip on the same track is held underneath.",
            "Clip transform x/y are pixel offsets from frame centre; scale 1 = fill the frame (fit: fill|fit|stretch).",
            "3D scene frames and durations are in project frames; scene keyframes are scene-relative.",
            "Motion effects (shake, beatPulse) animate the layer; beatPulse reacts to beat/downbeat markers inside the clip (run audio_analyze first).",
          ],
        },
      };
    },
  }),

  // ------------------------------------------------------------ media
  tool({
    name: "media_list_assets",
    description: "List imported assets with metadata, optionally filtered by kind.",
    input: z.object({ kind: z.enum(["video", "audio", "image", "model", "font", "lut"]).optional() }),
    mutates: false,
    async run(ctx, i) {
      const assets = session(ctx).project.assets.filter((a) => !i.kind || a.kind === i.kind);
      return { data: assets.map((a) => ({ id: a.id, kind: a.kind, name: a.name, status: a.status, meta: a.meta, tags: a.tags, bpm: a.analysis.beats?.bpm })) };
    },
  }),
  tool({
    name: "media_import",
    description: "Import media files by absolute path (originals are referenced, never modified). Allowed locations: the user's Videos, Music, Pictures, Downloads, Desktop, Documents folders and the project folder.",
    input: z.object({ paths: z.array(z.string().min(1)).min(1).max(100) }),
    mutates: true,
    async run(ctx, i) {
      const roots = mediaRoots(ctx);
      const denied = i.paths.filter((p) => !roots.some((r) => isInside(r, path.resolve(p))));
      if (denied.length) fail("permission_denied", `Outside allowed media folders: ${denied.join(", ")}`);
      const r = await ctx.engine.importMedia(i.paths, ctx.source);
      return { data: { imported: r.imported.map((a) => ({ id: a.id, kind: a.kind, name: a.name, meta: a.meta })), duplicates: r.duplicates, errors: r.errors } };
    },
  }),
  tool({
    name: "media_analyze",
    description: "Full metadata of one asset, plus derived-file status (thumbnail, proxy, waveform) and analysis results.",
    input: z.object({ assetId: Id }),
    mutates: false,
    async run(ctx, i) {
      const a = findAsset(session(ctx).project, i.assetId) ?? fail("not_found", `Asset ${i.assetId} not found`);
      const usedBy = session(ctx).project.tracks.flatMap((t) => t.clips.filter((c) => c.type === "media" && c.assetId === a.id).map((c) => ({ clipId: c.id, trackId: t.id, start: c.start })));
      return { data: { ...a, usedBy } };
    },
  }),
  tool({
    name: "media_search",
    description: "Search assets by name or tag (case-insensitive substring).",
    input: z.object({ query: z.string().min(1), kind: z.enum(["video", "audio", "image", "model", "font", "lut"]).optional() }),
    mutates: false,
    async run(ctx, i) {
      const q = i.query.toLowerCase();
      const hits = session(ctx).project.assets.filter((a) => (!i.kind || a.kind === i.kind) && (a.name.toLowerCase().includes(q) || a.tags.some((t) => t.toLowerCase().includes(q))));
      return { data: hits.map((a) => ({ id: a.id, kind: a.kind, name: a.name, duration: a.meta.duration })) };
    },
  }),
  tool({
    name: "media_tag",
    description: "Set tags / favourite on an asset.",
    input: z.object({ assetId: Id, tags: z.array(z.string().max(40)).max(30).optional(), favorite: z.boolean().optional() }),
    mutates: true,
    async run(ctx, i) {
      session(ctx).dispatch("asset.update", { assetId: i.assetId, patch: { ...(i.tags ? { tags: i.tags } : {}), ...(i.favorite !== undefined ? { favorite: i.favorite } : {}) } }, ctx.source, label("tag"));
      return { data: { ok: true } };
    },
  }),
  tool({
    name: "audio_analyze",
    description:
      "Detect tempo (BPM), beats, downbeats and strong transients of an audio/video asset. With applyMarkers (default), beat markers are written to the timeline where the asset is placed (or from frame 0). Detection is an estimate; markers are editable. Returns marker frames.",
    input: z.object({ assetId: Id, applyMarkers: z.boolean().default(true) }),
    mutates: true,
    async run(ctx, i) {
      const r = await ctx.engine.analyzeBeats(i.assetId, { applyMarkers: i.applyMarkers, source: ctx.source });
      const p = session(ctx).project;
      return {
        data: {
          bpm: r.analysis.bpm,
          confidence: r.analysis.confidence,
          beatsDetected: r.analysis.times.length,
          markers: r.markers,
          beatFrames: p.markers.filter((m) => m.kind === "beat" || m.kind === "downbeat").map((m) => m.frame),
          downbeatFrames: p.markers.filter((m) => m.kind === "downbeat").map((m) => m.frame),
          onsetFrames: p.markers.filter((m) => m.kind === "onset").map((m) => m.frame),
        },
      };
    },
  }),

  // ------------------------------------------------------------ timeline
  tool({
    name: "timeline_add_track",
    description: "Add a track. kind: video | text | scene | audio. index 0 = top layer; audio tracks default to the bottom.",
    input: z.object({ kind: z.enum(TRACK_KINDS), name: z.string().max(80).optional(), index: z.number().int().nonnegative().optional(), role: z.enum(["general", "music", "sfx", "dialogue"]).optional() }),
    mutates: true,
    async run(ctx, i) {
      return { data: session(ctx).dispatch("track.add", i, ctx.source, label("add track")) };
    },
  }),
  tool({
    name: "timeline_update_track",
    description: "Mute, solo, lock, hide, rename or set the gain of a track.",
    input: z.object({ trackId: Id, name: z.string().optional(), muted: z.boolean().optional(), solo: z.boolean().optional(), locked: z.boolean().optional(), hidden: z.boolean().optional(), volumeDb: z.number().min(-60).max(12).optional() }),
    mutates: true,
    async run(ctx, i) {
      session(ctx).dispatch("track.update", i, ctx.source, label("track"));
      return { data: { ok: true } };
    },
  }),
  tool({
    name: "timeline_add_clip",
    description:
      "Place a clip. type=media (assetId, optional sourceIn seconds, speed, duration frames - defaults to remaining source or 3 s for images), type=text (text, duration, style incl. fontAssetId of an imported font, animation), type=scene (sceneId), type=color (fill). Optional transform {x, y (pixels from frame centre), scale, rotation, fit} and name. mode=overwrite clears what is underneath; mode=error refuses overlaps.",
    input: z.object({
      trackId: Id,
      type: z.enum(["media", "text", "scene", "color"]),
      start: Frame,
      duration: z.number().int().positive().optional(),
      assetId: Id.optional(),
      sceneId: Id.optional(),
      sourceIn: z.number().nonnegative().optional(),
      speed: z.number().min(0.1).max(16).optional(),
      text: z.string().max(2000).optional(),
      fill: Hex.optional(),
      style: z
        .object({ fontFamily: z.string(), fontAssetId: Id, bold: z.boolean(), fontSize: z.number(), color: Hex, align: z.enum(["left", "center", "right"]), strokeWidth: z.number(), strokeColor: Hex, shadow: z.boolean(), box: z.boolean(), boxColor: Hex, boxOpacity: z.number() })
        .partial()
        .optional(),
      animation: z.object({ in: z.enum(TEXT_ANIMATIONS), out: z.enum(TEXT_ANIMATIONS), duration: z.number().int().min(1).max(300) }).partial().optional(),
      /** Position offset from frame centre (project pixels), scale, rotation, fit. */
      transform: z.object({ x: z.number(), y: z.number(), scale: z.number().positive(), rotation: z.number(), fit: z.enum(["fill", "fit", "stretch"]) }).partial().optional(),
      name: z.string().max(120).optional(),
      mode: z.enum(["overwrite", "error"]).default("overwrite"),
    }),
    mutates: true,
    async run(ctx, i) {
      let clip;
      switch (i.type) {
        case "media":
          clip = { type: "media" as const, assetId: i.assetId ?? fail("invalid_params", "assetId required"), start: i.start, duration: i.duration, sourceIn: i.sourceIn ?? 0, speed: i.speed ?? 1 };
          break;
        case "text":
          clip = { type: "text" as const, text: i.text ?? fail("invalid_params", "text required"), start: i.start, duration: i.duration ?? fail("invalid_params", "duration required for text"), style: i.style, animation: i.animation };
          break;
        case "scene":
          clip = { type: "scene" as const, sceneId: i.sceneId ?? fail("invalid_params", "sceneId required"), start: i.start, duration: i.duration, sourceIn: i.sourceIn ?? 0 };
          break;
        case "color":
          clip = { type: "color" as const, fill: i.fill ?? "#000000", start: i.start, duration: i.duration ?? fail("invalid_params", "duration required for colour clips") };
          break;
      }
      return {
        data: session(ctx).transaction(label("add clip"), ctx.source, (tx) => {
          const r = tx.dispatch("clip.add", { trackId: i.trackId, clip, mode: i.mode });
          if (i.transform || i.name) tx.dispatch("clip.update", { clipId: r.clipId, props: { ...(i.transform ? { transform: i.transform } : {}), ...(i.name ? { name: i.name } : {}) } });
          return r;
        }),
      };
    },
  }),
  tool({
    name: "timeline_place_sequence",
    description:
      "Lay out many shots on one track in a single undoable step. Each shot: assetId (or sceneId), start frame, duration frames, optional sourceIn seconds, speed, transitionIn {type, duration}, effects [{type, params}], look id. Ideal for building a montage cut to beat frames.",
    input: z.object({
      trackId: Id,
      clearTrack: z.boolean().default(false),
      shots: z
        .array(
          z.object({
            assetId: Id.optional(),
            sceneId: Id.optional(),
            start: Frame,
            duration: z.number().int().positive(),
            sourceIn: z.number().nonnegative().default(0),
            speed: z.number().min(0.1).max(16).default(1),
            transitionIn: z.object({ type: z.enum(TRANSITION_TYPES as [string, ...string[]]), duration: z.number().int().min(1).max(120) }).optional(),
            effects: z.array(z.object({ type: z.enum(EFFECT_TYPES as [string, ...string[]]), params: z.record(z.string(), z.unknown()).default({}) })).default([]),
            look: z.string().optional(),
            keyframes: z.array(z.object({ property: z.enum(KEYFRAME_PROPERTIES), frame: Frame, value: z.number(), easing: z.enum(EASINGS).default("easeInOut") })).default([]),
          }),
        )
        .min(1)
        .max(200),
    }),
    mutates: true,
    async run(ctx, i) {
      const ids: string[] = [];
      session(ctx).transaction(label(`place ${i.shots.length} shots`), ctx.source, (tx) => {
        if (i.clearTrack) {
          const t = tx.project.tracks.find((t) => t.id === i.trackId) ?? fail("not_found", `Track ${i.trackId} not found`);
          if (t.clips.length) tx.dispatch("clip.remove", { clipIds: t.clips.map((c) => c.id) });
        }
        for (const s of i.shots) {
          const clip = s.sceneId
            ? { type: "scene" as const, sceneId: s.sceneId, start: s.start, duration: s.duration, sourceIn: s.sourceIn }
            : { type: "media" as const, assetId: s.assetId ?? fail("invalid_params", "Each shot needs assetId or sceneId"), start: s.start, duration: s.duration, sourceIn: s.sourceIn, speed: s.speed };
          const r = tx.dispatch("clip.add", { trackId: i.trackId, clip });
          ids.push(r.clipId);
          if (s.transitionIn) tx.dispatch("clip.setTransition", { clipId: r.clipId, transition: { type: s.transitionIn.type, duration: Math.min(s.transitionIn.duration, r.duration) } });
          if (s.look) {
            const look = lookSpec(s.look) ?? fail("unsupported", `Unknown look ${s.look}`);
            for (const e of look.effects) tx.dispatch("effect.add", { clipId: r.clipId, type: e.type, params: e.params });
          }
          for (const e of s.effects) tx.dispatch("effect.add", { clipId: r.clipId, type: e.type, params: e.params });
          for (const k of s.keyframes) tx.dispatch("keyframe.set", { clipId: r.clipId, property: k.property, keyframe: { frame: Math.min(k.frame, r.duration), value: k.value, easing: k.easing } });
        }
      });
      const p = session(ctx).project;
      return { data: { clipIds: ids, clips: ids.map((id) => { const c = findClip(p, id)!.clip; return { id, start: c.start, duration: c.duration }; }) } };
    },
  }),
  tool({
    name: "timeline_move_clip",
    description: "Move a clip to a new start frame, optionally onto another track.",
    input: z.object({ clipId: Id, start: Frame, trackId: Id.optional(), mode: z.enum(["overwrite", "error"]).default("overwrite") }),
    mutates: true,
    async run(ctx, i) {
      return { data: session(ctx).dispatch("clip.move", i, ctx.source, label("move clip")) };
    },
  }),
  tool({
    name: "timeline_trim_clip",
    description: "Trim the start or end edge of a clip to an absolute timeline frame (start trims advance the source in-point).",
    input: z.object({ clipId: Id, edge: z.enum(["start", "end"]), frame: Frame }),
    mutates: true,
    async run(ctx, i) {
      return { data: session(ctx).dispatch("clip.trim", i, ctx.source, label("trim clip")) };
    },
  }),
  tool({
    name: "timeline_split_clip",
    description: "Split a clip at an absolute timeline frame.",
    input: z.object({ clipId: Id, frame: Frame }),
    mutates: true,
    async run(ctx, i) {
      return { data: session(ctx).dispatch("clip.split", i, ctx.source, label("split clip")) };
    },
  }),
  tool({
    name: "timeline_remove_clip",
    description: "Delete clips (ripple closes the gap on the same track).",
    input: z.object({ clipIds: z.array(Id).min(1), ripple: z.boolean().default(false) }),
    mutates: true,
    async run(ctx, i) {
      if (i.clipIds.length > 5) await requireApproval(ctx, "timeline_remove_clip", `Delete ${i.clipIds.length} clips`);
      return { data: session(ctx).dispatch("clip.remove", i, ctx.source, label("remove clips")) };
    },
  }),
  tool({
    name: "timeline_add_transition",
    description: `Set the transition into a clip from the previous shot on its track (null to clear). Types: ${TRANSITION_TYPES.join(", ")}.`,
    input: z.object({ clipId: Id, type: z.enum(TRANSITION_TYPES as [string, ...string[]]).nullable(), duration: z.number().int().min(1).max(600).default(12) }),
    mutates: true,
    async run(ctx, i) {
      session(ctx).dispatch("clip.setTransition", { clipId: i.clipId, transition: i.type ? { type: i.type, duration: i.duration } : null }, ctx.source, label("transition"));
      return { data: { ok: true } };
    },
  }),
  tool({
    name: "timeline_add_marker",
    description: "Add a timeline marker (cue or section).",
    input: z.object({ frame: Frame, label: z.string().max(80).default(""), kind: z.enum(["cue", "section", "beat"]).default("cue") }),
    mutates: true,
    async run(ctx, i) {
      return { data: session(ctx).dispatch("marker.add", { ...i, source: ctx.source === "user" ? "user" : "ai" }, ctx.source, label("marker")) };
    },
  }),
  tool({
    name: "timeline_set_keyframe",
    description: "Add/replace a keyframe on a clip property (opacity 0-1, x/y pixels, scale, rotation degrees, volume dB, speed 0.1-16x for video speed ramps). frame is relative to the clip start.",
    input: z.object({ clipId: Id, property: z.enum(KEYFRAME_PROPERTIES), frame: Frame, value: z.number(), easing: z.enum(EASINGS).default("easeInOut") }),
    mutates: true,
    async run(ctx, i) {
      session(ctx).dispatch("keyframe.set", { clipId: i.clipId, property: i.property, keyframe: { frame: i.frame, value: i.value, easing: i.easing } }, ctx.source, label("keyframe"));
      return { data: { ok: true } };
    },
  }),
  tool({
    name: "timeline_auto_edit",
    description:
      "One-call beat-synced montage: fill [start, end) frames of a video track with shots from assetIds (rotated in order, videos continue where they left off), cutting every N beat markers (on: beats|downbeats). Optional transition {type,duration}, look id and beat pulse zoom (0-0.5). Replaces what is on the track in that range. Run audio_analyze with applyMarkers first.",
    input: z.object({
      trackId: Id,
      assetIds: z.array(Id).min(1).max(200),
      start: Frame,
      end: Frame,
      every: z.number().int().min(1).max(32).default(2),
      on: z.enum(["beats", "downbeats"]).default("beats"),
      transition: z.object({ type: z.string(), duration: z.number().int().min(1).max(60) }).nullable().default(null),
      look: z.string().optional(),
      pulse: z.number().min(0).max(0.5).default(0),
    }),
    mutates: true,
    async run(ctx, i) {
      return { data: session(ctx).dispatch("timeline.autoEdit", i, ctx.source, label("auto edit to beats")) };
    },
  }),
  tool({
    name: "timeline_freeze_frame",
    description: "Freeze frame: split a video clip at an absolute timeline frame and insert a held still of that frame for duration frames (keeps the clip's look/transform). Later clips on the track move right.",
    input: z.object({ clipId: Id, frame: Frame, duration: z.number().int().min(1).max(100000) }),
    mutates: true,
    async run(ctx, i) {
      return { data: session(ctx).dispatch("clip.freezeFrame", i, ctx.source, label("freeze frame")) };
    },
  }),
  tool({
    name: "timeline_set_speed_ramp",
    description: `Speed ramp / velocity edit on a video clip: a preset (${SPEED_RAMP_PRESETS.join(", ")}), explicit speed keyframes (clip-relative frames, 0.1-16x), or null to clear. The clip is shortened if the ramp would run past its source; its own audio is muted while ramped. Great on beat drops: fast into the drop, slow-mo on the hit.`,
    input: z.object({
      clipId: Id,
      ramp: z.union([z.enum(SPEED_RAMP_PRESETS), z.array(z.object({ frame: Frame, value: z.number().min(0.1).max(16), easing: z.enum(EASINGS).default("easeInOut") })).min(1).max(200), z.null()]),
    }),
    mutates: true,
    async run(ctx, i) {
      return { data: session(ctx).dispatch("clip.setSpeedRamp", { clipId: i.clipId, ramp: i.ramp }, ctx.source, label("speed ramp")) };
    },
  }),
  tool({
    name: "timeline_set_clip_properties",
    description: "Change clip properties: opacity, blendMode, transform {x,y,scale,rotation,fit,crop}, fadeIn/fadeOut frames, speed, sourceIn, volumeDb, audioEnabled, reverse (play backwards), text, style, animation, fill, name.",
    input: z.object({ clipId: Id, props: z.record(z.string(), z.unknown()) }),
    mutates: true,
    async run(ctx, i) {
      return { data: session(ctx).dispatch("clip.update", { clipId: i.clipId, props: i.props as never }, ctx.source, label("clip properties")) };
    },
  }),
  tool({
    name: "edit_batch",
    description: `Apply several low-level editing commands atomically as one undo step. Allowed commands: ${COMMAND_NAMES.filter((c) => !c.startsWith("asset.add")).join(", ")}. Each item: {command, params}. If any command fails, nothing is applied.`,
    input: z.object({ label: z.string().max(80).default("batch edit"), commands: z.array(z.object({ command: z.string(), params: z.record(z.string(), z.unknown()) })).min(1).max(300) }),
    mutates: true,
    async run(ctx, i) {
      const results: unknown[] = [];
      session(ctx).transaction(label(i.label), ctx.source, (tx) => {
        i.commands.forEach((c, n) => {
          if (!COMMAND_NAMES.includes(c.command as CommandName) || c.command === "asset.add") fail("unsupported", `Command #${n} "${c.command}" is not allowed`);
          try {
            results.push(tx.dispatch(c.command as CommandName, c.params as never));
          } catch (e) {
            const p = toErrorPayload(e);
            fail(p.category, `Command #${n} (${c.command}) failed: ${p.message}`);
          }
        });
      });
      return { data: { applied: i.commands.length, results } };
    },
  }),

  // ------------------------------------------------------------ looks & effects
  tool({
    name: "look_apply",
    description: `Apply a named look (stack of colour/stylize effects) to clips. Looks: ${LOOKS.map((l) => l.id).join(", ")}. replace=true removes existing effects first.`,
    input: z.object({ clipIds: z.array(Id).min(1), look: z.string(), replace: z.boolean().default(true) }),
    mutates: true,
    async run(ctx, i) {
      const look = lookSpec(i.look) ?? fail("unsupported", `Unknown look "${i.look}". Available: ${LOOKS.map((l) => l.id).join(", ")}`);
      session(ctx).transaction(label(`look ${look.id}`), ctx.source, (tx) => {
        for (const clipId of i.clipIds) {
          if (i.replace) {
            const c = findClip(tx.project, clipId) ?? fail("not_found", `Clip ${clipId} not found`);
            for (const e of c.clip.effects) tx.dispatch("effect.remove", { clipId, effectId: e.id });
          }
          for (const e of look.effects) tx.dispatch("effect.add", { clipId, type: e.type, params: e.params });
        }
      });
      return { data: { ok: true, effects: look.effects.map((e) => e.type) } };
    },
  }),
  tool({
    name: "effect_add",
    description: "Add an effect to a clip's stack. Params are validated and clamped to supported ranges (see capabilities).",
    input: z.object({ clipId: Id, type: z.enum(EFFECT_TYPES as [string, ...string[]]), params: z.record(z.string(), z.unknown()).default({}) }),
    mutates: true,
    async run(ctx, i) {
      return { data: session(ctx).dispatch("effect.add", i, ctx.source, label(`effect ${i.type}`)) };
    },
  }),
  tool({
    name: "effect_update",
    description: "Change an effect's parameters or enable/disable it.",
    input: z.object({ clipId: Id, effectId: Id, params: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean().optional() }),
    mutates: true,
    async run(ctx, i) {
      session(ctx).dispatch("effect.update", i, ctx.source, label("effect update"));
      return { data: { ok: true } };
    },
  }),
  tool({
    name: "effect_remove",
    description: "Remove an effect from a clip.",
    input: z.object({ clipId: Id, effectId: Id }),
    mutates: true,
    async run(ctx, i) {
      session(ctx).dispatch("effect.remove", i, ctx.source, label("effect remove"));
      return { data: { ok: true } };
    },
  }),

  // ------------------------------------------------------------ 3D scenes
  tool({
    name: "scene_create",
    description: `Create a 3D scene (rendered by Blender) from a template: ${SCENE_TEMPLATES.map((t) => `${t.id} - ${t.description}`).join(" | ")}. durationFrames is in project frames. Place it on the timeline with timeline_add_clip type=scene.`,
    input: z.object({
      name: z.string().min(1).max(120),
      template: z.enum(SCENE_TEMPLATE_IDS as [string, ...string[]]).default("empty"),
      durationFrames: z.number().int().min(1).max(100000),
      text: z.string().max(200).optional(),
      accentA: Hex.optional(),
      accentB: Hex.optional(),
      material: z.enum(MATERIAL_PRESETS).optional(),
      modelAssetId: Id.optional(),
      particles: z.boolean().optional(),
      fog: z.number().min(0).max(1).optional(),
    }),
    mutates: true,
    async run(ctx, i) {
      return { data: session(ctx).dispatch("scene.create", i, ctx.source, label(`scene ${i.name}`)) };
    },
  }),
  tool({
    name: "scene_add_object",
    description: "Add a mesh primitive, imported model (model.assetId) or particle field to a scene. Rotation in degrees; Blender axes (Z up, cameras typically look along +Y).",
    input: z.object({
      sceneId: Id,
      kind: z.enum(["mesh", "model", "particles"]),
      name: z.string().max(80).optional(),
      primitive: z.enum(MESH_PRIMITIVES).default("cube"),
      size: z.number().positive().default(1),
      modelAssetId: Id.optional(),
      location: Vec3.default([0, 0, 0]),
      rotation: Vec3.default([0, 0, 0]),
      scale: Vec3.default([1, 1, 1]),
      particleCount: z.number().int().min(1).max(5000).optional(),
      particleColor: Hex.optional(),
    }),
    mutates: true,
    async run(ctx, i) {
      const object = {
        kind: i.kind,
        name: i.name ?? i.kind,
        location: i.location,
        rotation: i.rotation,
        scale: i.scale,
        ...(i.kind === "mesh" ? { mesh: { primitive: i.primitive, size: i.size, smooth: true } } : {}),
        ...(i.kind === "model" ? { model: { assetId: i.modelAssetId ?? fail("invalid_params", "modelAssetId required") } } : {}),
        ...(i.kind === "particles" ? { particles: { count: i.particleCount ?? 400, size: 0.03, color: i.particleColor ?? "#ffffff", emission: 6, area: [6, 6, 4] as [number, number, number], drift: 0.5, seed: 1 } } : {}),
      };
      return { data: session(ctx).dispatch("scene.addObject", { sceneId: i.sceneId, object }, ctx.source, label("3D object")) };
    },
  }),
  tool({
    name: "scene_add_text",
    description: "Add extruded 3D text to a scene.",
    input: z.object({ sceneId: Id, text: z.string().min(1).max(200), size: z.number().positive().default(1), extrude: z.number().min(0).max(5).default(0.15), bevel: z.number().min(0).max(1).default(0.02), location: Vec3.default([0, 0, 0]), rotation: Vec3.default([90, 0, 0]), material: z.enum(MATERIAL_PRESETS).default("chrome"), color: Hex.default("#e8e8f0") }),
    mutates: true,
    async run(ctx, i) {
      return {
        data: session(ctx).dispatch(
          "scene.addObject",
          {
            sceneId: i.sceneId,
            object: {
              kind: "text",
              name: i.text.slice(0, 30),
              location: i.location,
              rotation: i.rotation,
              text: { body: i.text, size: i.size, extrude: i.extrude, bevel: i.bevel, align: "center", letterSpacing: 1 },
              material: { preset: i.material, baseColor: i.color, metallic: 0.5, roughness: 0.3, emissionColor: "#000000", emissionStrength: 0, transmission: 0 },
            },
          },
          ctx.source,
          label("3D text"),
        ),
      };
    },
  }),
  tool({
    name: "scene_add_camera",
    description: "Add a camera (optionally tracking an object, with depth of field). makeActive switches the scene's render camera.",
    input: z.object({ sceneId: Id, name: z.string().default("Camera"), location: Vec3, rotation: Vec3.default([90, 0, 0]), focalLength: z.number().min(5).max(500).default(35), dof: z.boolean().default(false), focusDistance: z.number().positive().default(5), fStop: z.number().min(0.5).max(64).default(2.8), trackTargetId: Id.optional(), makeActive: z.boolean().default(true) }),
    mutates: true,
    async run(ctx, i) {
      let id = "";
      session(ctx).transaction(label("camera"), ctx.source, (tx) => {
        id = tx.dispatch("scene.addObject", { sceneId: i.sceneId, object: { kind: "camera", name: i.name, location: i.location, rotation: i.rotation, camera: { focalLength: i.focalLength, dof: i.dof, focusDistance: i.focusDistance, fStop: i.fStop, trackTargetId: i.trackTargetId } } }).objectId;
        if (i.makeActive) tx.dispatch("scene.update", { sceneId: i.sceneId, activeCameraId: id });
      });
      return { data: { objectId: id } };
    },
  }),
  tool({
    name: "scene_add_light",
    description: "Add a light (point, sun, area, spot). Energy in watts (sun: irradiance).",
    input: z.object({ sceneId: Id, type: z.enum(["point", "sun", "area", "spot"]).default("area"), name: z.string().default("Light"), location: Vec3, rotation: Vec3.default([0, 0, 0]), color: Hex.default("#ffffff"), energy: z.number().min(0).max(1e6).default(800), size: z.number().min(0).default(2) }),
    mutates: true,
    async run(ctx, i) {
      return { data: session(ctx).dispatch("scene.addObject", { sceneId: i.sceneId, object: { kind: "light", name: i.name, location: i.location, rotation: i.rotation, light: { type: i.type, color: i.color, energy: i.energy, size: i.size } } }, ctx.source, label("light")) };
    },
  }),
  tool({
    name: "scene_update_object",
    description: "Update a scene object's transform, visibility, material or kind-specific settings (camera/light/text/particles fields).",
    input: z.object({ sceneId: Id, objectId: Id, patch: z.record(z.string(), z.unknown()) }),
    mutates: true,
    async run(ctx, i) {
      session(ctx).dispatch("scene.updateObject", { sceneId: i.sceneId, objectId: i.objectId, patch: i.patch as never }, ctx.source, label("3D object update"));
      return { data: { ok: true } };
    },
  }),
  tool({
    name: "scene_set_material",
    description: "Set the material of a mesh, text or model object.",
    input: z.object({ sceneId: Id, objectId: Id, preset: z.enum(MATERIAL_PRESETS).default("custom"), baseColor: Hex.default("#cccccc"), metallic: z.number().min(0).max(1).default(0), roughness: z.number().min(0).max(1).default(0.5), emissionColor: Hex.default("#000000"), emissionStrength: z.number().min(0).max(100).default(0), transmission: z.number().min(0).max(1).default(0) }),
    mutates: true,
    async run(ctx, { sceneId, objectId, ...material }) {
      session(ctx).dispatch("scene.updateObject", { sceneId, objectId, patch: { material } }, ctx.source, label("material"));
      return { data: { ok: true } };
    },
  }),
  tool({
    name: "scene_animate",
    description: "Replace the keyframes of one property on a scene object. location/rotation(deg)/scale take 3 values; focalLength, focusDistance (cameras) and energy (lights) take 1. Frames are scene-relative (0 = first frame).",
    input: z.object({ sceneId: Id, objectId: Id, property: z.enum(SCENE_ANIM_PROPERTIES), keyframes: z.array(z.object({ frame: Frame, value: z.array(z.number()).min(1).max(3), easing: z.enum(EASINGS).default("easeInOut") })).max(500) }),
    mutates: true,
    async run(ctx, i) {
      session(ctx).dispatch("scene.animate", i, ctx.source, label("3D animation"));
      return { data: { ok: true } };
    },
  }),
  tool({
    name: "scene_set_render_settings",
    description: `Scene render/world settings. preset (${RENDER_PRESET_IDS.join(", ")}) sets engine/samples/denoise/motion blur in one go (Cycles uses the GPU automatically); render fields override it: engine (eevee|cycles|workbench), samples, denoise, motionBlur, shutter, bloom, transparent, viewTransform, look; world colour, strength, fog, reflections; durationFrames; activeCameraId.`,
    input: z.object({
      sceneId: Id,
      preset: z.enum(RENDER_PRESET_IDS as [string, ...string[]]).optional(),
      durationFrames: z.number().int().min(1).max(100000).optional(),
      activeCameraId: Id.optional(),
      render: z.object({ engine: z.enum(["eevee", "cycles", "workbench"]), samples: z.number().int().min(1).max(4096), denoise: z.boolean(), motionBlur: z.boolean(), shutter: z.number(), bloom: z.boolean(), transparent: z.boolean(), viewTransform: z.enum(["AgX", "Filmic", "Standard"]), look: z.enum(["None", "Punchy", "High Contrast", "Base Contrast", "Medium Contrast"]) }).partial().optional(),
      world: z.object({ color: Hex, strength: z.number(), fog: z.number().min(0).max(1), reflections: z.number().min(0).max(20) }).partial().optional(),
    }),
    mutates: true,
    async run(ctx, i) {
      const { preset, ...rest } = i;
      const render = preset ? { ...RENDER_PRESETS.find((r) => r.id === preset)!.render, ...rest.render } : rest.render;
      session(ctx).dispatch("scene.update", { ...rest, render }, ctx.source, label("3D render settings"));
      return { data: { ok: true, render: session(ctx).project.scenes.find((x) => x.id === i.sceneId)?.render, cyclesDevice: ctx.engine.deps.blender?.cyclesDevice } };
    },
  }),
  tool({
    name: "scene_preview",
    description: "Render a draft frame of a 3D scene with Blender and return it as an image for visual review. frame is scene-relative.",
    input: z.object({ sceneId: Id, frame: Frame.default(0) }),
    mutates: false,
    async run(ctx, i) {
      const s = session(ctx);
      const scene = s.project.scenes.find((x) => x.id === i.sceneId) ?? fail("not_found", `Scene ${i.sceneId} not found`);
      const f = Math.min(i.frame, scene.durationFrames - 1) + 1;
      const r = await ctx.engine.renderScene(i.sceneId, { quality: "draft", scale: 0.4, frames: [f] });
      const file = path.join(r.dir, `frame_${String(f).padStart(5, "0")}.png`);
      return { data: { path: file, warnings: r.warnings }, images: [{ path: file, caption: `Scene "${scene.name}" frame ${i.frame} (draft)` }] };
    },
  }),

  // ------------------------------------------------------------ rendering
  tool({
    name: "preview_render",
    description: "Render up to 6 timeline frames (draft quality, composited exactly like the export) and return them as images for visual review. Also reports which clips are visible at each frame.",
    input: z.object({ frames: z.array(Frame).min(1).max(6), scale: z.number().min(0.1).max(1).default(0.4) }),
    mutates: false,
    async run(ctx, i) {
      const images: ToolImage[] = [];
      const info: unknown[] = [];
      for (const f of i.frames) {
        if (ctx.signal?.aborted) fail("cancelled", "Cancelled");
        const r = await ctx.engine.renderStill(f, { scale: i.scale });
        images.push({ path: r.path, caption: `Timeline frame ${r.frame}` });
        info.push({ frame: r.frame, path: r.path, warnings: r.warnings });
      }
      return { data: { frames: info }, images };
    },
  }),
  tool({
    name: "preview_render_range",
    description: "Render a draft MP4 of a frame range for playback in the app viewer (not returned as images).",
    input: z.object({ start: Frame, end: Frame }),
    mutates: false,
    async run(ctx, i) {
      const r = await ctx.engine.renderPreviewRange(i.start, i.end);
      return { data: { path: r.path, cached: r.cached, warnings: r.warnings } };
    },
  }),
  tool({
    name: "project_validate_render",
    description: "Pre-flight check for export: validation errors, missing dependencies, aspect mismatches, and an estimate (frames, seconds, 3D frames to render).",
    input: z.object({ preset: z.string().optional() }),
    mutates: false,
    async run(ctx, i) {
      return { data: ctx.engine.validateRender({ preset: i.preset }) };
    },
  }),
  tool({
    name: "audio_set_ducking",
    description:
      "Automatic music ducking: music-role tracks dip by amountDb while clips on dialogue-role (and optionally sfx-role) tracks play, with attack/release ramps in frames. Set track roles with timeline_update_track.",
    input: z.object({
      enabled: z.boolean().optional(),
      amountDb: z.number().min(0).max(40).optional(),
      attackFrames: z.number().int().min(0).max(120).optional(),
      releaseFrames: z.number().int().min(0).max(240).optional(),
      triggers: z.array(z.enum(["dialogue", "sfx"])).min(1).optional(),
    }),
    mutates: true,
    async run(ctx, i) {
      session(ctx).dispatch("project.setMix", { ducking: i }, ctx.source, label("ducking"));
      return { data: session(ctx).project.mix };
    },
  }),
  tool({
    name: "export_set_settings",
    description:
      "Delivery settings used by export_render: codec (h264|h265|prores), crf (quality, lower = better), encoderPreset, audioBitrateK, loudnessLufs (e.g. -14 for social platforms, -23 broadcast, null = as mixed).",
    input: z.object({
      codec: z.enum(["h264", "h265", "prores"]).optional(),
      crf: z.number().int().min(0).max(51).optional(),
      encoderPreset: z.enum(["ultrafast", "veryfast", "fast", "medium", "slow"]).optional(),
      audioBitrateK: z.number().int().min(64).max(512).optional(),
      loudnessLufs: z.number().min(-30).max(-8).nullable().optional(),
    }),
    mutates: true,
    async run(ctx, i) {
      session(ctx).dispatch("project.setExport", i, ctx.source, label("export settings"));
      return { data: session(ctx).project.export };
    },
  }),
  tool({
    name: "export_render",
    description: `Start the final export (Blender final-quality 3D frames + FFmpeg composition + verification). Returns a jobId; with wait=true it waits up to ${MAX_TOOL_WAIT_S} s (MCP clients time out around 60 s) and otherwise returns status "running" — then poll export_status with waitSeconds. Presets: reel1080, square1080, landscape1080, landscape4k, reel4k, master (ProRes).`,
    input: z.object({ preset: z.string().optional(), outPath: z.string().optional(), wait: z.boolean().default(false) }),
    mutates: false,
    async run(ctx, i) {
      const check = ctx.engine.validateRender({ preset: i.preset });
      await requireApproval(ctx, "export_render", `Final export (${check.estimate.seconds.toFixed(1)} s, ${check.estimate.sceneFrames} 3D frames)`);
      if (i.outPath) {
        const s = session(ctx);
        const roots = [...mediaRoots(ctx), s.dir];
        if (!roots.some((r) => isInside(r, path.resolve(i.outPath!)))) fail("permission_denied", "Export path must be inside the project folder or a user media folder");
      }
      const { job, promise } = ctx.engine.startExport({ preset: i.preset, outPath: i.outPath });
      if (i.wait) {
        const r = await Promise.race([promise, sleep(MAX_TOOL_WAIT_S * 1000).then(() => undefined)]);
        if (r) return { data: { jobId: job.id, status: "done", ...r } };
        const j = ctx.engine.jobs.get(job.id)!;
        return { data: { jobId: job.id, status: j.status, progress: j.progress, message: j.message, hint: "Still rendering: call export_status with waitSeconds until status is done." } };
      }
      return { data: { jobId: job.id, status: job.status } };
    },
  }),
  tool({
    name: "timeline_export_otio",
    description: "Export the timeline as an OpenTimelineIO (.otio) file for other editors (Resolve, Premiere via adapters, ...). Defaults to <project>/exports/<name>.otio.",
    input: z.object({ outPath: z.string().optional() }),
    mutates: false,
    async run(ctx, i) {
      const s = session(ctx);
      const out = i.outPath ? path.resolve(i.outPath) : path.join(s.dir, "exports", `${safeName(s.project.name)}.otio`);
      if (!mediaRoots(ctx).some((r) => isInside(r, out))) fail("permission_denied", "OTIO path must be inside the project folder or a user media folder");
      return { data: await exportOtio(ctx.engine, out) };
    },
  }),
  tool({
    name: "captions_import",
    description: `Import subtitles (.srt or .vtt) as styled caption text clips on a new top "Captions" track (one undo step). style: ${CAPTION_STYLES.join(", ")} (bold = stroked, pops in; boxed = background box; karaoke = yellow stroked). position: bottom (above platform UI on vertical video), middle, top. offsetFrames shifts all cues.`,
    input: z.object({ path: z.string().min(1), style: z.enum(CAPTION_STYLES).default("bold"), position: z.enum(["bottom", "middle", "top"]).default("bottom"), offsetFrames: z.number().int().default(0) }),
    mutates: true,
    async run(ctx, i) {
      const p = path.resolve(i.path);
      if (!mediaRoots(ctx).some((r) => isInside(r, p))) fail("permission_denied", "Subtitle file must be inside the project folder or a user media folder");
      return { data: await importCaptions(ctx.engine, p, { style: i.style, position: i.position, offsetFrames: i.offsetFrames }, ctx.source === "mcp" ? "mcp" : "ai") };
    },
  }),
  tool({
    name: "captions_export",
    description: "Write the text clips of a track (e.g. the Captions track) as an .srt subtitle file for platforms. Defaults to <project>/exports/<name>.srt.",
    input: z.object({ trackId: Id, outPath: z.string().optional() }),
    mutates: false,
    async run(ctx, i) {
      const s = session(ctx);
      const out = i.outPath ? path.resolve(i.outPath) : path.join(s.dir, "exports", `${safeName(s.project.name)}.srt`);
      if (!mediaRoots(ctx).some((r) => isInside(r, out))) fail("permission_denied", "SRT path must be inside the project folder or a user media folder");
      return { data: await exportCaptions(ctx.engine, i.trackId, out) };
    },
  }),
  tool({
    name: "timeline_import_otio",
    description: "Import an OpenTimelineIO (.otio) timeline into the open project as new tracks (one undo step). Referenced media files are imported.",
    input: z.object({ path: z.string().min(1) }),
    mutates: true,
    async run(ctx, i) {
      const p = path.resolve(i.path);
      const roots = mediaRoots(ctx);
      if (!roots.some((r) => isInside(r, p))) fail("permission_denied", "OTIO file must be inside the project folder or a user media folder");
      return { data: await importOtio(ctx.engine, p, ctx.source === "mcp" ? "mcp" : "ai", { allowedRoots: roots }) };
    },
  }),
  tool({
    name: "export_status",
    description: `Status/progress/result of a background job (export, preview, scene render). waitSeconds (≤ ${MAX_TOOL_WAIT_S}) waits for the job to finish before answering.`,
    input: z.object({ jobId: Id, waitSeconds: z.number().min(0).max(MAX_TOOL_WAIT_S).default(0) }),
    mutates: false,
    async run(ctx, i) {
      const deadline = Date.now() + i.waitSeconds * 1000;
      for (;;) {
        const j = ctx.engine.jobs.get(i.jobId) ?? fail("not_found", `Job ${i.jobId} not found`);
        if (j.status !== "queued" && j.status !== "running") return { data: j };
        if (Date.now() >= deadline) return { data: j };
        await sleep(Math.min(500, deadline - Date.now()));
      }
    },
  }),
  tool({
    name: "job_cancel",
    description: "Cancel a queued or running job.",
    input: z.object({ jobId: Id }),
    mutates: false,
    async run(ctx, i) {
      return { data: { cancelled: ctx.engine.jobs.cancel(i.jobId) } };
    },
  }),
  tool({
    name: "plan_save",
    description: "Record the edit plan (shot list) for this brief so the user can inspect it in the AI panel. Call after planning and update status as you go.",
    input: z.object({
      planId: Id.optional(),
      brief: z.string().max(4000),
      summary: z.string().max(4000).default(""),
      status: z.enum(["draft", "approved", "executing", "done", "failed", "cancelled"]).default("draft"),
      shots: z.array(z.object({ index: z.number().int(), description: z.string(), startFrame: z.number().int(), durationFrames: z.number().int(), source: z.string().optional(), transition: z.string().optional(), notes: z.string().optional() })).max(300).default([]),
      details: z.record(z.string(), z.unknown()).default({}),
    }),
    mutates: false,
    async run(ctx, { planId, ...plan }) {
      // Plans are bookkeeping, not edits: stored without an undo step.
      return { data: session(ctx).applySystem("ai.savePlan", { ...(planId ? { id: planId } : {}), ...plan }) };
    },
  }),
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Validate and execute one tool call. Never throws; errors become results. */
export async function executeTool(ctx: ToolContext, name: string, rawInput: unknown): Promise<ToolResult> {
  const def = TOOL_MAP.get(name);
  if (!def) return { ok: false, error: { category: "unsupported", message: `Unknown tool "${name}"` } };
  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success) return { ok: false, error: toErrorPayload(parsed.error) as ToolResult["error"] };
  try {
    if (!ctx.engine.session && !["project_create", "project_open", "capabilities"].includes(name)) fail("not_found", "No project is open. Use project_create or open a project in the app.");
    const out = await def.run(ctx, parsed.data);
    return { ok: true, data: out.data, images: out.images };
  } catch (e) {
    const p = toErrorPayload(e);
    return { ok: false, error: { category: p.category, message: p.message } };
  }
}

export function toolJsonSchema(def: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(def.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export async function imageBase64(file: string): Promise<string> {
  return (await readFile(file)).toString("base64");
}
