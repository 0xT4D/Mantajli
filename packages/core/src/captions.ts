import type { Project, TextStyle } from "./schema.js";
import { fpsValue } from "./time.js";
import { clipEnd } from "./timeline.js";

/**
 * Subtitles: SRT / WebVTT parsing and writing, and caption styling for text
 * clips. Pure functions; the engine turns cues into clips through commands.
 */

export interface Cue {
  /** Seconds. */
  start: number;
  end: number;
  text: string;
}

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function parseTime(s: string): number | undefined {
  const m = TIME.exec(s.trim());
  if (!m) return undefined;
  const [, h, min, sec, ms] = m;
  return Number(h ?? 0) * 3600 + Number(min) * 60 + Number(sec) + Number(ms!.padEnd(3, "0")) / 1000;
}

/** Strip simple markup (<i>, <b>, <font>, {\an8}) that the renderer does not style. */
function cleanText(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .trim();
}

/** Parse SRT or WebVTT text into cues sorted by start time. Malformed blocks are skipped. */
export function parseSubtitles(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue; // WEBVTT header, NOTE, STYLE, or junk
    const [a, b] = lines[at]!.split("-->");
    const start = parseTime(a ?? "");
    const end = parseTime((b ?? "").trim().split(/\s+/)[0] ?? "");
    const body = cleanText(lines.slice(at + 1));
    if (start === undefined || end === undefined || end <= start || !body) continue;
    cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

export function formatSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}

/** Cues from the text clips of a track (timeline seconds). */
export function trackCues(p: Project, trackId: string): Cue[] {
  const fps = fpsValue(p.settings.fps);
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return [];
  return t.clips
    .filter((c) => c.type === "text")
    .sort((a, b) => a.start - b.start)
    .map((c) => ({ start: c.start / fps, end: clipEnd(c) / fps, text: c.type === "text" ? c.text : "" }));
}

export const CAPTION_STYLES = ["clean", "bold", "boxed", "karaoke"] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number];
export type CaptionPosition = "bottom" | "middle" | "top";

/**
 * Text style, vertical offset and animation for a caption preset, sized from
 * the frame. Vertical video keeps captions above the platform UI at the bottom.
 */
export function captionLook(style: CaptionStyle, position: CaptionPosition, width: number, height: number) {
  const vertical = height > width;
  const size = Math.round(Math.min(width, height) * (style === "bold" || style === "karaoke" ? 0.075 : 0.06));
  const yOff = position === "middle" ? 0 : (position === "bottom" ? 1 : -1) * height * (vertical ? 0.2 : 0.36);
  const base: Partial<TextStyle> = { fontSize: size, align: "center", bold: true, color: "#ffffff", shadow: false, box: false, strokeWidth: 0 };
  const look: Partial<TextStyle> =
    style === "clean"
      ? { ...base, bold: false, shadow: true, strokeWidth: Math.max(1, Math.round(size * 0.035)), strokeColor: "#000000" }
      : style === "bold"
        ? { ...base, strokeWidth: Math.max(2, Math.round(size * 0.08)), strokeColor: "#000000" }
        : style === "boxed"
          ? { ...base, box: true, boxColor: "#000000", boxOpacity: 0.65 }
          : { ...base, color: "#ffe14d", strokeWidth: Math.max(2, Math.round(size * 0.09)), strokeColor: "#000000" };
  const animation = style === "bold" || style === "karaoke" ? { in: "pop" as const, out: "none" as const, duration: 4 } : { in: "fade" as const, out: "fade" as const, duration: 3 };
  return { style: look, y: Math.round(yOff), animation };
}
