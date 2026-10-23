import type { Project } from "./schema.js";
import { fpsValue } from "./time.js";
import { projectDuration } from "./timeline.js";
import { validateProject } from "./validate.js";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Compact project description for the AI. Keeps ids and the numbers needed to
 * edit, omits derived file paths and verbose defaults.
 */
export function summarizeProject(p: Project, opts: { selection?: string[]; includeValidation?: boolean } = {}) {
  const fps = fpsValue(p.settings.fps);
  const duration = projectDuration(p);
  const beats = p.markers.filter((m) => m.kind === "beat" || m.kind === "downbeat");
  return {
    project: {
      id: p.id,
      name: p.name,
      width: p.settings.width,
      height: p.settings.height,
      fps: r2(fps),
      fpsRational: `${p.settings.fps.num}/${p.settings.fps.den}`,
      durationFrames: duration,
      durationSeconds: r2(duration / fps),
      export: p.export,
    },
    assets: p.assets.map((a) => ({
      id: a.id,
      kind: a.kind,
      name: a.name,
      status: a.status,
      ...(a.meta.duration !== undefined ? { duration: r2(a.meta.duration) } : {}),
      ...(a.meta.width ? { size: `${a.meta.width}x${a.meta.height}` } : {}),
      ...(a.meta.fps ? { fps: r2(a.meta.fps.num / a.meta.fps.den) } : {}),
      ...(a.kind === "video" ? { hasAudio: a.meta.hasAudio } : {}),
      ...(a.analysis.beats ? { bpm: r2(a.analysis.beats.bpm), beatCount: a.analysis.beats.times.length } : {}),
      ...(a.tags.length ? { tags: a.tags } : {}),
    })),
    tracks: p.tracks.map((t, i) => ({
      id: t.id,
      index: i,
      name: t.name,
      kind: t.kind,
      role: t.role,
      ...(t.muted ? { muted: true } : {}),
      ...(t.hidden ? { hidden: true } : {}),
      ...(t.locked ? { locked: true } : {}),
      ...(t.solo ? { solo: true } : {}),
      clips: t.clips.map((c) => ({
        id: c.id,
        type: c.type,
        start: c.start,
        duration: c.duration,
        end: c.start + c.duration,
        ...(c.type === "media" ? { assetId: c.assetId, sourceIn: r2(c.sourceIn), ...(c.speed !== 1 ? { speed: c.speed } : {}), ...(c.volumeDb ? { volumeDb: c.volumeDb } : {}) } : {}),
        ...(c.type === "scene" ? { sceneId: c.sceneId, sourceIn: r2(c.sourceIn) } : {}),
        ...(c.type === "text" ? { text: c.text, animation: `${c.animation.in}/${c.animation.out}` } : {}),
        ...(c.type === "color" ? { fill: c.fill } : {}),
        ...(c.opacity !== 1 ? { opacity: c.opacity } : {}),
        ...(c.transitionIn ? { transitionIn: `${c.transitionIn.type}:${c.transitionIn.duration}f` } : {}),
        ...(c.fadeIn || c.fadeOut ? { fades: `${c.fadeIn}/${c.fadeOut}` } : {}),
        ...(c.effects.length ? { effects: c.effects.map((e) => ({ id: e.id, type: e.type, ...(e.enabled ? {} : { enabled: false }) })) } : {}),
        ...(Object.keys(c.keyframes).length ? { keyframed: Object.keys(c.keyframes) } : {}),
        ...(c.transform.scale !== 1 || c.transform.x || c.transform.y || c.transform.rotation
          ? { transform: { x: c.transform.x, y: c.transform.y, scale: c.transform.scale, rotation: c.transform.rotation } }
          : {}),
      })),
    })),
    scenes: p.scenes.map((s) => ({
      id: s.id,
      name: s.name,
      template: s.template,
      durationFrames: s.durationFrames,
      engine: s.render.engine,
      activeCameraId: s.activeCameraId,
      objects: s.objects.map((o) => ({
        id: o.id,
        kind: o.kind,
        name: o.name,
        ...(o.text ? { text: o.text.body } : {}),
        ...(o.animation.length ? { animated: o.animation.map((a) => a.property) } : {}),
      })),
    })),
    markers: {
      beatFrames: beats.map((m) => m.frame),
      downbeatFrames: beats.filter((m) => m.kind === "downbeat").map((m) => m.frame),
      onsetFrames: p.markers.filter((m) => m.kind === "onset").map((m) => m.frame),
      other: p.markers.filter((m) => !["beat", "downbeat", "onset"].includes(m.kind)).map((m) => ({ id: m.id, frame: m.frame, kind: m.kind, label: m.label })),
    },
    ...(opts.selection?.length ? { selection: opts.selection } : {}),
    ...(opts.includeValidation !== false ? { issues: validateProject(p).slice(0, 30) } : {}),
  };
}
