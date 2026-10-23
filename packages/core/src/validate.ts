import { effectSpec } from "./effects.js";
import type { Project } from "./schema.js";
import { clipEnd, findAsset, findScene, maxClipDuration } from "./timeline.js";

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  clipId?: string;
  trackId?: string;
  assetId?: string;
  sceneId?: string;
}

/** Structural checks beyond the schema: references, overlaps, source ranges. */
export function validateProject(p: Project): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  const dup = (id: string) => {
    if (ids.has(id)) issues.push({ severity: "error", code: "duplicate_id", message: `Duplicate id ${id}` });
    ids.add(id);
  };
  for (const a of p.assets) {
    dup(a.id);
    if (a.status === "missing") issues.push({ severity: "error", code: "missing_file", message: `Media file missing: ${a.path}`, assetId: a.id });
  }
  for (const s of p.scenes) {
    dup(s.id);
    if (!s.objects.some((o) => o.kind === "camera")) issues.push({ severity: "error", code: "scene_no_camera", message: `Scene "${s.name}" has no camera`, sceneId: s.id });
    for (const o of s.objects) {
      if (o.kind === "model" && o.model && !findAsset(p, o.model.assetId))
        issues.push({ severity: "error", code: "missing_asset", message: `Scene "${s.name}" object "${o.name}" references a missing model`, sceneId: s.id });
    }
  }
  for (const t of p.tracks) {
    dup(t.id);
    const sorted = [...t.clips].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i]!;
      dup(c.id);
      const next = sorted[i + 1];
      if (next && clipEnd(c) > next.start)
        issues.push({ severity: "error", code: "overlap", message: `Clips ${c.id} and ${next.id} overlap on track "${t.name}"`, clipId: next.id, trackId: t.id });
      if (c.type === "media") {
        const a = findAsset(p, c.assetId);
        if (!a) issues.push({ severity: "error", code: "missing_asset", message: `Clip ${c.id} references unknown asset ${c.assetId}`, clipId: c.id });
        else if (a.status !== "ok") issues.push({ severity: "error", code: "missing_file", message: `Clip ${c.id} uses missing media "${a.name}"`, clipId: c.id, assetId: a.id });
        else if (c.duration > maxClipDuration(p, c) + 1)
          issues.push({ severity: "warning", code: "source_overrun", message: `Clip ${c.id} runs past the end of its source; the last frame will be held`, clipId: c.id });
      }
      if (c.type === "scene" && !findScene(p, c.sceneId))
        issues.push({ severity: "error", code: "missing_scene", message: `Clip ${c.id} references unknown scene ${c.sceneId}`, clipId: c.id });
      for (const fx of c.effects) {
        if (!effectSpec(fx.type)) issues.push({ severity: "error", code: "unsupported_effect", message: `Unsupported effect ${fx.type}`, clipId: c.id });
        if (fx.type === "lut" && !findAsset(p, String(fx.params.assetId)))
          issues.push({ severity: "error", code: "missing_asset", message: `LUT effect on clip ${c.id} references a missing asset`, clipId: c.id });
      }
      if (c.transitionIn && c.transitionIn.duration > c.duration)
        issues.push({ severity: "warning", code: "transition_too_long", message: `Transition into ${c.id} is longer than the clip`, clipId: c.id });
    }
  }
  if (p.settings.width % 2 || p.settings.height % 2)
    issues.push({ severity: "error", code: "odd_resolution", message: "Width and height must be even for H.264 export" });
  return issues;
}
