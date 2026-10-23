import { readFile } from "node:fs/promises";
import path from "node:path";
import { captionLook, fail, formatSrt, fpsValue, parseSubtitles, trackCues, type CaptionPosition, type CaptionStyle } from "@mantagli/core";
import type { Engine } from "../engine.js";
import { writeFileAtomic } from "../util/fsx.js";

export interface CaptionImportOptions {
  style?: CaptionStyle;
  position?: CaptionPosition;
  /** Shift every cue by this many timeline frames. */
  offsetFrames?: number;
}

/**
 * Import an .srt / .vtt file as styled text clips on a new top "Captions"
 * track, as one undo step. Overlapping cues are trimmed to the next start.
 */
export async function importCaptions(engine: Engine, file: string, opts: CaptionImportOptions = {}, source: "user" | "ai" | "mcp" = "user") {
  const s = engine.requireSession();
  const ext = path.extname(file).toLowerCase();
  if (ext !== ".srt" && ext !== ".vtt") fail("unsupported", "Captions must be an .srt or .vtt file");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    fail("not_found", `Cannot read ${file}: ${(e as Error).message}`);
  }
  const cues = parseSubtitles(text);
  if (!cues.length) fail("invalid_params", "No subtitle cues found in the file");
  const p = s.project;
  const fps = fpsValue(p.settings.fps);
  const look = captionLook(opts.style ?? "bold", opts.position ?? "bottom", p.settings.width, p.settings.height);
  const offset = opts.offsetFrames ?? 0;
  const frames = cues
    .map((c) => ({ start: Math.round(c.start * fps) + offset, end: Math.round(c.end * fps) + offset, text: c.text.slice(0, 2000) }))
    .filter((c) => c.end > 0);
  let skipped = cues.length - frames.length;
  return s.transaction(`Import captions ${path.basename(file)}`, source, (tx) => {
    const { trackId } = tx.dispatch("track.add", { kind: "text", name: "Captions", index: 0 });
    let clips = 0;
    frames.forEach((c, i) => {
      const start = Math.max(0, c.start);
      const next = frames[i + 1];
      const end = Math.min(c.end, next ? Math.max(start + 1, next.start) : c.end);
      if (end <= start) {
        skipped++;
        return;
      }
      tx.dispatch("clip.add", {
        trackId,
        clip: { type: "text", text: c.text, start, duration: end - start, style: look.style, animation: look.animation, transform: { y: look.y }, name: c.text.split("\n")[0]!.slice(0, 40) },
      });
      clips++;
    });
    return { trackId, clips, skipped, firstFrame: frames[0]?.start ?? 0 };
  });
}

/** Write the text clips of a track as an .srt file. */
export async function exportCaptions(engine: Engine, trackId: string, outPath: string): Promise<{ path: string; cues: number }> {
  if (path.extname(outPath).toLowerCase() !== ".srt") fail("invalid_params", "Captions export path must end in .srt");
  const cues = trackCues(engine.project, trackId);
  if (!cues.length) fail("invalid_params", "That track has no text clips to export");
  await writeFileAtomic(outPath, formatSrt(cues));
  return { path: outPath, cues: cues.length };
}
