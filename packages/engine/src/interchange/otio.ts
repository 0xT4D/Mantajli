import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  clipEnd,
  fail,
  findAsset,
  fpsValue,
  SceneSchema,
  type Clip,
  type Marker,
  type Project,
  type Track,
} from "@mantagli/core";
import type { Engine } from "../engine.js";
import { isInside, writeFileAtomic } from "../util/fsx.js";

/**
 * OpenTimelineIO interchange (otio_json, schema versions as written by
 * OpenTimelineIO 0.18: Timeline.1, Stack.1, Track.1, Clip.2, Gap.1,
 * Transition.1, Marker.2, LinearTimeWarp.1, ExternalReference.1,
 * MissingReference.1).
 *
 * Clips carry their full Mantagli definition in metadata.mantagli so a
 * Mantagli → OTIO → Mantagli round trip keeps text, 3D scenes, effects and
 * keyframes; other applications see standard clips, gaps, transitions,
 * speed changes and markers.
 */

type Json = Record<string, unknown>;

const RT = (value: number, rate: number): Json => ({ OTIO_SCHEMA: "RationalTime.1", rate, value });
const TR = (start: number, duration: number, rate: number): Json => ({ OTIO_SCHEMA: "TimeRange.1", start_time: RT(start, rate), duration: RT(duration, rate) });

const MARKER_COLORS: Record<Marker["kind"], string> = { cue: "RED", beat: "YELLOW", downbeat: "ORANGE", section: "PURPLE", onset: "PINK" };

function item(schema: string, name: string, extra: Json): Json {
  return { OTIO_SCHEMA: schema, metadata: {}, name, effects: [], markers: [], enabled: true, color: null, ...extra };
}

export function projectToOtio(p: Project): Json {
  const fps = fpsValue(p.settings.fps);
  const trackJson = (t: Track): Json => {
    const children: Json[] = [];
    let pos = 0;
    const clips = [...t.clips].sort((a, b) => a.start - b.start);
    clips.forEach((c, i) => {
      if (c.start > pos) children.push(item("Gap.1", "", { source_range: TR(0, c.start - pos, fps) }));
      const prev = clips[i - 1];
      if (c.transitionIn && prev && clipEnd(prev) === c.start) {
        children.push({
          OTIO_SCHEMA: "Transition.1",
          metadata: { mantagli: { type: c.transitionIn.type } },
          name: c.transitionIn.type,
          in_offset: RT(0, fps),
          out_offset: RT(c.transitionIn.duration, fps),
          transition_type: c.transitionIn.type === "crossfade" ? "SMPTE_Dissolve" : "Custom_Transition",
        });
      }
      children.push(clipJson(p, c, fps));
      pos = clipEnd(c);
    });
    return item("Track.1", t.name, {
      metadata: { mantagli: { id: t.id, kind: t.kind, role: t.role, muted: t.muted, solo: t.solo, locked: t.locked, hidden: t.hidden, volumeDb: t.volumeDb } },
      source_range: null,
      children,
      kind: t.kind === "audio" ? "Audio" : "Video",
      enabled: !(t.hidden || t.muted),
    });
  };
  // OTIO stacks list the bottom track first; Mantagli lists the top layer first.
  const visual = p.tracks.filter((t) => t.kind !== "audio").reverse();
  const audio = p.tracks.filter((t) => t.kind === "audio");
  return {
    OTIO_SCHEMA: "Timeline.1",
    metadata: { mantagli: { schemaVersion: p.schemaVersion, projectId: p.id, settings: p.settings, scenes: p.scenes } },
    name: p.name,
    global_start_time: RT(0, fps),
    tracks: item("Stack.1", "tracks", {
      source_range: null,
      markers: p.markers.map((m) => ({
        OTIO_SCHEMA: "Marker.2",
        metadata: { mantagli: { kind: m.kind, source: m.source, strength: m.strength } },
        name: m.label || m.kind,
        color: MARKER_COLORS[m.kind],
        marked_range: TR(m.frame, 0, fps),
        comment: "",
      })),
      children: [...visual, ...audio].map(trackJson),
    }),
  };
}

function clipJson(p: Project, c: Clip, fps: number): Json {
  const sourceIn = c.type === "media" || c.type === "scene" ? c.sourceIn : 0;
  let ref: Json;
  if (c.type === "media") {
    const a = findAsset(p, c.assetId);
    ref = a
      ? {
          OTIO_SCHEMA: "ExternalReference.1",
          metadata: { mantagli: { assetId: a.id, kind: a.kind } },
          name: a.name,
          available_range: a.meta.duration !== undefined ? TR(0, Math.round(a.meta.duration * fps), fps) : null,
          available_image_bounds: null,
          target_url: pathToFileURL(a.path).href,
        }
      : { OTIO_SCHEMA: "MissingReference.1", metadata: {}, name: c.assetId, available_range: null, available_image_bounds: null };
  } else {
    ref = { OTIO_SCHEMA: "MissingReference.1", metadata: { mantagli: { generator: c.type } }, name: c.type, available_range: null, available_image_bounds: null };
  }
  return item("Clip.2", c.type === "text" ? c.text.split("\n")[0]! : c.name || c.type, {
    metadata: { mantagli: { clip: c } },
    source_range: TR(sourceIn * fps, c.duration, fps),
    effects: c.type === "media" && c.speed !== 1 ? [{ OTIO_SCHEMA: "LinearTimeWarp.1", metadata: {}, name: "", effect_name: "LinearTimeWarp", enabled: true, time_scalar: c.speed }] : [],
    media_references: { DEFAULT_MEDIA: ref },
    active_media_reference_key: "DEFAULT_MEDIA",
  });
}

export async function exportOtio(engine: Engine, outPath: string): Promise<{ path: string; tracks: number; clips: number }> {
  const p = engine.project;
  if (path.extname(outPath).toLowerCase() !== ".otio") fail("invalid_params", "OTIO export path must end in .otio");
  await writeFileAtomic(outPath, JSON.stringify(projectToOtio(p), null, 2));
  return { path: outPath, tracks: p.tracks.length, clips: p.tracks.reduce((n, t) => n + t.clips.length, 0) };
}

// ------------------------------------------------------------------ import

interface RationalJson {
  rate: number;
  value: number;
}

function secondsOf(rt: unknown): number {
  const r = rt as RationalJson | null;
  if (!r || typeof r.value !== "number" || typeof r.rate !== "number" || r.rate <= 0) return 0;
  return r.value / r.rate;
}

export interface OtioImportResult {
  tracks: number;
  clips: number;
  markers: number;
  importedMedia: number;
  warnings: string[];
}

export interface OtioImportOptions {
  /** When set, referenced media outside these folders is skipped (AI/MCP import boundary). */
  allowedRoots?: string[];
}

/** Import an .otio timeline into the open project as new tracks (one undo step). */
export async function importOtio(engine: Engine, file: string, source: "user" | "ai" | "mcp" = "user", opts: OtioImportOptions = {}): Promise<OtioImportResult> {
  const s = engine.requireSession();
  let doc: Json;
  try {
    doc = JSON.parse(await readFile(file, "utf8")) as Json;
  } catch (e) {
    fail("invalid_params", `Not a readable OTIO JSON file: ${(e as Error).message}`);
  }
  if (typeof doc.OTIO_SCHEMA !== "string" || !doc.OTIO_SCHEMA.startsWith("Timeline.")) fail("unsupported", "Only OTIO Timeline documents are supported");
  const fps = fpsValue(s.project.settings.fps);
  const toFrames = (rt: unknown) => Math.round(secondsOf(rt) * fps);
  const warnings: string[] = [];
  const stack = doc.tracks as Json | undefined;
  const otioTracks = ((stack?.children as Json[]) ?? []).filter((t) => {
    if (String(t.OTIO_SCHEMA).startsWith("Track.")) return true;
    warnings.push(`Skipped nested ${String(t.OTIO_SCHEMA)} (only flat tracks are supported)`);
    return false;
  });
  const meta = (doc.metadata as Json | undefined)?.mantagli as Json | undefined;

  // 1) Import referenced media files (outside the edit transaction; not undone with it).
  const urls = new Set<string>();
  for (const t of otioTracks)
    for (const c of (t.children as Json[]) ?? []) {
      const ref = activeRef(c);
      if (ref && String(ref.OTIO_SCHEMA).startsWith("ExternalReference.")) urls.add(String(ref.target_url));
    }
  const assetByUrl = new Map<string, string>();
  let importedMedia = 0;
  for (const url of urls) {
    let p: string;
    try {
      p = url.startsWith("file:") ? fileURLToPath(url) : path.resolve(path.dirname(file), url);
    } catch {
      warnings.push(`Unsupported media URL ${url}`);
      continue;
    }
    if (opts.allowedRoots && !opts.allowedRoots.some((r) => isInside(r, p))) {
      warnings.push(`${path.basename(p)}: outside the allowed media folders, not imported`);
      continue;
    }
    const r = await engine.importMedia([p], source);
    const id = r.imported[0]?.id ?? r.duplicates[0]?.assetId;
    if (id) assetByUrl.set(url, id);
    if (r.imported.length) importedMedia++;
    for (const e of r.errors) warnings.push(`${path.basename(p)}: ${e.message}`);
  }

  // 2) Recreate scenes carried in Mantagli metadata (for 3D clips).
  const sceneIdMap = new Map<string, string>();
  const scenes = Array.isArray(meta?.scenes) ? (meta!.scenes as unknown[]) : [];

  let clipCount = 0;
  let markerCount = 0;
  const label = `Import OTIO ${path.basename(file)}`;
  s.transaction(label, source, (tx) => {
    for (const raw of scenes) {
      const parsed = SceneSchema.safeParse(raw);
      if (!parsed.success) continue;
      const exists = tx.project.scenes.some((x) => x.id === parsed.data.id);
      if (exists) {
        sceneIdMap.set(parsed.data.id, parsed.data.id);
        continue;
      }
      try {
        // Re-create through the command layer from an empty template, then copy objects/settings.
        const created = tx.dispatch("scene.create", { name: parsed.data.name, durationFrames: parsed.data.durationFrames, template: "empty" });
        sceneIdMap.set(parsed.data.id, created.sceneId);
        for (const o of created.objectIds) tx.dispatch("scene.removeObject", { sceneId: created.sceneId, objectId: o.id });
        for (const o of parsed.data.objects) {
          const { id: _id, animation, ...rest } = o;
          const added = tx.dispatch("scene.addObject", { sceneId: created.sceneId, object: rest });
          for (const a of animation) tx.dispatch("scene.animate", { sceneId: created.sceneId, objectId: added.objectId, property: a.property, keyframes: a.keyframes });
          if (parsed.data.activeCameraId === o.id) tx.dispatch("scene.update", { sceneId: created.sceneId, activeCameraId: added.objectId });
        }
        tx.dispatch("scene.update", { sceneId: created.sceneId, world: parsed.data.world, render: parsed.data.render });
      } catch (e) {
        warnings.push(`Scene "${parsed.data.name}" partially imported: ${(e as Error).message}`);
      }
    }

    // OTIO lists the bottom track first; insert so the top OTIO track ends up on top.
    const visualOtio = otioTracks.filter((t) => t.kind !== "Audio");
    const audioOtio = otioTracks.filter((t) => t.kind === "Audio");
    const created: { otio: Json; trackId: string }[] = [];
    for (const t of visualOtio) {
      const m = (t.metadata as Json | undefined)?.mantagli as Json | undefined;
      const kind = (m?.kind as Track["kind"]) ?? "video";
      const r = tx.dispatch("track.add", { kind: kind === "audio" ? "video" : kind, name: String(t.name || "OTIO"), index: 0 });
      created.push({ otio: t, trackId: r.trackId });
    }
    for (const t of audioOtio) {
      const m = (t.metadata as Json | undefined)?.mantagli as Json | undefined;
      const r = tx.dispatch("track.add", { kind: "audio", name: String(t.name || "OTIO Audio"), role: (m?.role as "music") ?? undefined });
      created.push({ otio: t, trackId: r.trackId });
    }

    for (const { otio, trackId } of created) {
      let pos = 0;
      let pendingTransition: { type: string; duration: number } | null = null;
      for (const c of (otio.children as Json[]) ?? []) {
        const schema = String(c.OTIO_SCHEMA);
        if (schema.startsWith("Gap.")) {
          pos += toFrames((c.source_range as Json | undefined)?.duration);
          pendingTransition = null;
          continue;
        }
        if (schema.startsWith("Transition.")) {
          const tm = ((c.metadata as Json | undefined)?.mantagli as Json | undefined)?.type as string | undefined;
          const d = toFrames(c.in_offset) + toFrames(c.out_offset);
          pendingTransition = d > 0 ? { type: tm ?? "crossfade" /* SMPTE_Dissolve and unknown types map to a dissolve */, duration: d } : null;
          continue;
        }
        if (!schema.startsWith("Clip.")) {
          warnings.push(`Skipped ${schema}`);
          continue;
        }
        const range = c.source_range as Json | undefined;
        const duration = Math.max(1, toFrames(range?.duration));
        const sourceIn = secondsOf(range?.start_time);
        const mClip = ((c.metadata as Json | undefined)?.mantagli as Json | undefined)?.clip as Clip | undefined;
        const ref = activeRef(c);
        const speed = Number(((c.effects as Json[]) ?? []).find((e) => String(e.OTIO_SCHEMA).startsWith("LinearTimeWarp."))?.time_scalar ?? 1) || 1;
        const name = mClip?.name || (typeof c.name === "string" && c.name ? c.name : undefined);
        let clipId: string | undefined;
        try {
          if (ref && String(ref.OTIO_SCHEMA).startsWith("ExternalReference.")) {
            const assetId = assetByUrl.get(String(ref.target_url));
            if (!assetId) {
              warnings.push(`Clip "${String(c.name)}" skipped: media unavailable (${String(ref.target_url)})`);
              pos += duration;
              pendingTransition = null;
              continue;
            }
            clipId = tx.dispatch("clip.add", { trackId, clip: { type: "media", assetId, start: pos, duration, sourceIn, speed: Math.min(16, Math.max(0.1, speed)), name } }).clipId;
          } else if (mClip?.type === "text") {
            clipId = tx.dispatch("clip.add", { trackId, clip: { type: "text", text: mClip.text, start: pos, duration, style: mClip.style, animation: mClip.animation, transform: mClip.transform, name } }).clipId;
          } else if (mClip?.type === "color") {
            clipId = tx.dispatch("clip.add", { trackId, clip: { type: "color", fill: mClip.fill, start: pos, duration, name } }).clipId;
          } else if (mClip?.type === "adjustment") {
            clipId = tx.dispatch("clip.add", { trackId, clip: { type: "adjustment", start: pos, duration, name } }).clipId;
          } else if (mClip?.type === "scene" && sceneIdMap.has(mClip.sceneId)) {
            clipId = tx.dispatch("clip.add", { trackId, clip: { type: "scene", sceneId: sceneIdMap.get(mClip.sceneId)!, start: pos, duration, sourceIn, name } }).clipId;
          } else {
            warnings.push(`Clip "${String(c.name)}" skipped: no media reference`);
          }
        } catch (e) {
          warnings.push(`Clip "${String(c.name)}" skipped: ${(e as Error).message}`);
        }
        if (clipId) {
          clipCount++;
          try {
            // Carry Mantagli-only attributes (effects, keyframes, fades, transform, opacity).
            if (mClip) {
              const props: Record<string, unknown> = { opacity: mClip.opacity, blendMode: mClip.blendMode, transform: mClip.transform, fadeIn: mClip.fadeIn, fadeOut: mClip.fadeOut };
              if (mClip.type === "media") Object.assign(props, { volumeDb: mClip.volumeDb, audioEnabled: mClip.audioEnabled });
              tx.dispatch("clip.update", { clipId, props: props as never });
              for (const fx of mClip.effects) tx.dispatch("effect.add", { clipId, type: fx.type, params: fx.params });
              for (const [prop, kfs] of Object.entries(mClip.keyframes)) {
                if (!kfs?.length) continue;
                // A ramp is set in one go: partial ramps would re-clamp the clip length.
                if (prop === "speed") tx.dispatch("clip.setSpeedRamp", { clipId, ramp: kfs });
                else for (const k of kfs) tx.dispatch("keyframe.set", { clipId, property: prop as "opacity", keyframe: k });
              }
            }
            if (pendingTransition) {
              tx.dispatch("clip.setTransition", { clipId, transition: { type: pendingTransition.type, duration: Math.min(pendingTransition.duration, duration) } });
            }
          } catch (e) {
            warnings.push(`Clip "${String(c.name)}": some attributes not imported (${(e as Error).message})`);
          }
        }
        pendingTransition = null;
        pos += duration;
      }
      // Track flags last, so a locked track still receives its clips.
      const m = (otio.metadata as Json | undefined)?.mantagli as Partial<Track> | undefined;
      const flags = { muted: m?.muted, solo: m?.solo, hidden: m?.hidden, volumeDb: m?.volumeDb, locked: m?.locked };
      if (!m && otio.enabled === false) flags.hidden = flags.muted = true;
      try {
        tx.dispatch("track.update", { trackId, ...flags });
      } catch (e) {
        warnings.push(`Track "${String(otio.name)}": flags not imported (${(e as Error).message})`);
      }
    }

    const markers = [...(((stack?.markers as Json[]) ?? []))];
    for (const t of otioTracks) markers.push(...(((t.markers as Json[]) ?? [])));
    for (const m of markers) {
      const mm = (m.metadata as Json | undefined)?.mantagli as Json | undefined;
      const kind = (mm?.kind as Marker["kind"]) ?? "cue";
      tx.dispatch("marker.add", { frame: Math.max(0, toFrames((m.marked_range as Json | undefined)?.start_time)), label: kind === "beat" || kind === "downbeat" || kind === "onset" ? "" : String(m.name ?? ""), kind });
      markerCount++;
    }
  });
  return { tracks: otioTracks.length, clips: clipCount, markers: markerCount, importedMedia, warnings };
}

function activeRef(c: Json): Json | undefined {
  const refs = c.media_references as Record<string, Json> | undefined;
  if (refs) return refs[String(c.active_media_reference_key ?? "DEFAULT_MEDIA")] ?? Object.values(refs)[0];
  return c.media_reference as Json | undefined; // Clip.1
}
