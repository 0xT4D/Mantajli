/**
 * Sound design: the registry of procedural sound effects (engine media/sfx.ts renders them) and
 * context-aware suggestions that place them where the picture or the music calls for one.
 *
 * Suggestions read the real timeline: transitions (a whip wants a whoosh at its peak, a zoom
 * through a riser into a hit), song sections (impacts on drops, downlifters into breakdowns —
 * skipped when the music is Mantagli's own, which already has them), and titles (a glitch under
 * a scramble, a blip for a typewriter, a hit for a title on a downbeat). Rules keep the mix
 * clear: one effect per moment, minimum spacing, a density cap, nothing over existing effects,
 * and quieter (or no) accents under dialogue.
 */
import { fpsValue } from "./time.js";
import type { Project } from "./schema.js";

export const SFX_KINDS = ["whoosh", "riser", "impact", "hit", "glitch", "blip", "downlifter"] as const;
export type SfxKind = (typeof SFX_KINDS)[number];

/** Default length (s) and where the "moment" is, as a fraction of the length (whoosh peak, riser end). */
export const SFX_SPECS: Record<SfxKind, { duration: number; anchor: number; description: string }> = {
  whoosh: { duration: 0.8, anchor: 0.62, description: "Air sweep that peaks at the anchor: whip pans, fast moves, slides." },
  riser: { duration: 2, anchor: 1, description: "Noise and pitch rising into the anchor (ends there): builds into a drop or a reveal." },
  impact: { duration: 2.5, anchor: 0, description: "Deep boom with a noise burst, starting at the anchor: drops, title slams, logo hits." },
  hit: { duration: 0.5, anchor: 0, description: "Short punchy transient at the anchor: snap cuts, text pops, beat accents." },
  glitch: { duration: 0.35, anchor: 0, description: "Digital stutter at the anchor: glitch cuts, scrambled text." },
  blip: { duration: 0.12, anchor: 0, description: "UI beep at the anchor: cursors, menu selections, typing." },
  downlifter: { duration: 1.5, anchor: 0, description: "Falling sweep from the anchor: breakdowns, endings." },
};

/**
 * Timeline start frame and length for an effect placed at an anchor frame:
 * risers end on it, whooshes peak on it, everything else starts on it.
 */
export function sfxPlacement(kind: SfxKind, anchorFrame: number, fps: number, duration?: number): { start: number; frames: number } {
  const spec = SFX_SPECS[kind];
  const dur = duration ?? spec.duration;
  const frames = Math.max(1, Math.round(dur * fps));
  const start = Math.round(anchorFrame - spec.anchor * dur * fps);
  return { start: Math.max(0, start), frames };
}

export interface SoundSuggestion {
  kind: SfxKind;
  /** Frame the effect's moment lands on (see sfxPlacement). */
  anchorFrame: number;
  gainDb: number;
  pitch?: number;
  /** Seconds, for effects that stretch (risers). */
  duration?: number;
  reason: string;
  trigger: "transition" | "section" | "title";
  /** Clip or marker the suggestion answers. */
  ref: string;
}

export interface SoundDesignOptions {
  intensity?: "subtle" | "normal" | "bold";
  start?: number;
  end?: number;
}

const PRIORITY = { transition: 3, section: 2, title: 1 } as const;

export function suggestSoundDesign(p: Project, opts: SoundDesignOptions = {}): SoundSuggestion[] {
  const fps = fpsValue(p.settings.fps);
  const sec = (s: number) => Math.round(s * fps);
  const offset = opts.intensity === "subtle" ? -4 : opts.intensity === "bold" ? 3 : 0;
  const raw: (SoundSuggestion & { priority: number })[] = [];
  const push = (s: SoundSuggestion) => raw.push({ ...s, gainDb: s.gainDb + offset, priority: PRIORITY[s.trigger] });

  // ---- transitions on visual tracks
  for (const t of p.tracks) {
    if (t.kind === "audio" || t.hidden) continue;
    for (const c of t.clips) {
      const tr = c.transitionIn;
      if (!tr) continue;
      const peak = c.start + Math.round(tr.duration / 2);
      const type = tr.type;
      if (type.startsWith("whip")) push({ kind: "whoosh", anchorFrame: peak, gainDb: -6, pitch: type === "whipUp" ? 1.15 : type === "whipDown" ? 0.85 : 1, reason: `whip pan into "${c.name}"`, trigger: "transition", ref: c.id });
      else if (type === "zoomThrough") {
        push({ kind: "riser", anchorFrame: peak, gainDb: -12, duration: Math.min(1.5, Math.max(0.5, (tr.duration / fps) * 2)), reason: `zoom through into "${c.name}" builds to the cut`, trigger: "transition", ref: c.id });
        push({ kind: "hit", anchorFrame: peak, gainDb: -6, reason: `zoom-through cut into "${c.name}"`, trigger: "transition", ref: c.id });
      } else if (type === "glitchCut") push({ kind: "glitch", anchorFrame: peak - sec(0.1), gainDb: -8, reason: `glitch cut into "${c.name}"`, trigger: "transition", ref: c.id });
      else if (type === "flash") push({ kind: "hit", anchorFrame: c.start, gainDb: -9, reason: `flash into "${c.name}"`, trigger: "transition", ref: c.id });
      else if (type.startsWith("slide") || type.startsWith("wipe") || type === "iris" || type === "zoomIn")
        push({ kind: "whoosh", anchorFrame: peak, gainDb: -13, reason: `${type} into "${c.name}" (soft)`, trigger: "transition", ref: c.id });
    }
  }

  // ---- song sections (markers from beat analysis or generated music)
  const generatedMusicAt = (f: number) =>
    p.tracks.some((t) => t.role === "music" && !t.muted && t.clips.some((c) => c.type === "media" && f >= c.start && f < c.start + c.duration && (p.assets.find((a) => a.id === c.assetId)?.tags ?? []).includes("generated")));
  const sections = p.markers.filter((m) => m.kind === "section").sort((a, b) => a.frame - b.frame);
  sections.forEach((m, i) => {
    if (generatedMusicAt(m.frame)) return; // the score already rises and hits there
    const label = (m.label ?? "").toLowerCase();
    if (label === "drop") {
      const prev = sections[i - 1]?.frame ?? 0;
      push({ kind: "riser", anchorFrame: m.frame, gainDb: -12, duration: Math.min(2, Math.max(0.6, (m.frame - prev) / fps)), reason: "build into the drop", trigger: "section", ref: m.id });
      push({ kind: "impact", anchorFrame: m.frame, gainDb: -8, reason: "the drop", trigger: "section", ref: m.id });
    } else if (label === "breakdown") push({ kind: "downlifter", anchorFrame: m.frame, gainDb: -12, reason: "into the breakdown", trigger: "section", ref: m.id });
  });

  // ---- titles (not captions)
  const accents = p.markers.filter((m) => m.kind === "downbeat" || m.kind === "section").map((m) => m.frame);
  for (const t of p.tracks) {
    if (t.kind !== "text" || t.hidden || t.name === "Captions") continue;
    for (const c of t.clips) {
      if (c.type !== "text" || c.name.startsWith("Caption:")) continue;
      const anim = c.animation.in;
      const title = c.text.split("\n")[0]!.slice(0, 30);
      if (anim === "scramble") push({ kind: "glitch", anchorFrame: c.start, gainDb: -16, reason: `"${title}" decodes`, trigger: "title", ref: c.id });
      else if (anim === "typewriter") push({ kind: "blip", anchorFrame: c.start, gainDb: -18, reason: `"${title}" starts typing`, trigger: "title", ref: c.id });
      else if (accents.some((f) => Math.abs(f - c.start) <= 2)) push({ kind: "hit", anchorFrame: c.start, gainDb: -12, reason: `"${title}" lands on a strong beat`, trigger: "title", ref: c.id });
    }
  }

  // ---- keep the mix clear
  const existing: number[] = [];
  for (const t of p.tracks)
    if (t.kind === "audio" && t.role === "sfx")
      for (const c of t.clips) {
        const kind = SFX_KINDS.find((k) => c.name === k);
        existing.push(kind ? c.start + Math.round(SFX_SPECS[kind].anchor * c.duration) : c.start);
      }
  const dialogue = p.tracks.filter((t) => t.kind === "audio" && t.role === "dialogue" && !t.muted).flatMap((t) => t.clips.map((c) => [c.start, c.start + c.duration] as const));
  const underDialogue = (f: number) => dialogue.some(([a, b]) => f >= a && f < b);
  const minGap: Partial<Record<SfxKind, number>> = { whoosh: sec(0.6), hit: sec(0.5), glitch: sec(0.5), blip: sec(0.3), impact: sec(2) };
  const accepted: (SoundSuggestion & { priority: number })[] = [];
  const candidates = raw
    .filter((s) => s.anchorFrame >= (opts.start ?? 0) && s.anchorFrame < (opts.end ?? Infinity) && s.anchorFrame >= 0)
    .sort((a, b) => b.priority - a.priority || a.anchorFrame - b.anchorFrame);
  for (const s of candidates) {
    if (existing.some((f) => Math.abs(f - s.anchorFrame) <= 6)) continue; // already has an effect there
    // One moment, one sound: a riser and the hit it builds into may share a frame; nothing else.
    const clash = accepted.some((a) => Math.abs(a.anchorFrame - s.anchorFrame) <= 6 && !(a.ref === s.ref && a.kind !== s.kind) && !(a.anchorFrame === s.anchorFrame && (a.kind === "riser") !== (s.kind === "riser")));
    if (clash) continue;
    const gap = minGap[s.kind];
    if (gap && accepted.some((a) => a.kind === s.kind && Math.abs(a.anchorFrame - s.anchorFrame) < gap)) continue;
    if (underDialogue(s.anchorFrame)) {
      if (s.trigger === "title") continue; // accents would mask the voice
      s.gainDb -= 6;
      s.reason += " (quieter under dialogue)";
    }
    accepted.push(s);
  }
  // Density: at most ~0.6 effects per second of timeline (+2), dropping titles first.
  const span = Math.max(1, Math.max(0, ...p.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration))) / fps);
  const cap = Math.ceil(span * 0.6) + 2;
  accepted.sort((a, b) => b.priority - a.priority || a.anchorFrame - b.anchorFrame);
  const kept = accepted.slice(0, cap);
  return kept
    .sort((a, b) => a.anchorFrame - b.anchorFrame)
    .map(({ priority: _p, ...s }) => ({ ...s, gainDb: Math.round(s.gainDb * 10) / 10 }));
}
