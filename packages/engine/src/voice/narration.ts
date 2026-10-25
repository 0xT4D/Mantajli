/**
 * Narration helpers: speaking-time estimates for planning a script against the edit, and
 * caption cues for a spoken segment.
 *
 * Caption timing is distributed over the measured length of the generated audio in proportion
 * to each chunk's spoken weight (characters plus pauses at punctuation). It is not speech
 * recognition, so a word can land a few frames early or late; cues never cross the audio.
 */

/** Typical narration pace at rate 1 (words per minute). */
export const NARRATION_WPM = 150;

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/** Estimated speaking time (s) of `text` at `rate`, including pauses at sentence ends and commas. */
export function estimateSpeechSeconds(text: string, rate = 1): number {
  const stops = (text.match(/[.!?…]+(\s|$)/g) ?? []).length;
  const commas = (text.match(/[,;:—–]/g) ?? []).length;
  return (words(text) / NARRATION_WPM) * 60 / Math.max(0.5, rate) + stops * 0.35 + commas * 0.15;
}

/** Split text into caption chunks: sentences, long ones at commas or by words (≤ maxChars). */
export function captionChunks(text: string, maxChars = 42): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?…]+[.!?…]*["')\]]*\s*/g) ?? [];
  const out: string[] = [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length <= maxChars) {
      out.push(s);
      continue;
    }
    // Prefer clause breaks, then fill by words.
    const parts = s.split(/(?<=[,;:—–])\s+/);
    let cur = "";
    for (const part of parts) {
      for (const w of part.split(" ")) {
        if (cur && (cur + " " + w).length > maxChars) {
          out.push(cur);
          cur = w;
        } else cur = cur ? `${cur} ${w}` : w;
      }
      if (/[,;:—–]$/.test(cur) && cur.length > maxChars * 0.5) {
        out.push(cur);
        cur = "";
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

const weight = (chunk: string) => chunk.length + (/[.!?…]["')\]]*$/.test(chunk) ? 6 : /[,;:—–]$/.test(chunk) ? 3 : 0);

/** Cues (seconds, relative to the audio start) covering `duration` for the chunks of `text`. */
export function captionCues(text: string, duration: number, maxChars = 42): { text: string; start: number; end: number }[] {
  const chunks = captionChunks(text, maxChars);
  const total = chunks.reduce((s, c) => s + weight(c), 0) || 1;
  let t = 0;
  return chunks.map((c) => {
    const d = (weight(c) / total) * duration;
    const cue = { text: c, start: t, end: t + d };
    t += d;
    return cue;
  });
}
