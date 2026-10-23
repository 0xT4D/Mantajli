/**
 * Time model.
 *
 * Timeline positions and durations are integer frame indices at the project
 * frame rate. Frame rates are rationals (e.g. 30000/1001) so NTSC rates are
 * exact. Source-media offsets are stored in seconds because sources can have
 * any (or variable) frame rate; they are converted deliberately at the edge.
 */

export interface Rational {
  num: number;
  den: number;
}

export const FPS_PRESETS: Record<string, Rational> = {
  "23.976": { num: 24000, den: 1001 },
  "24": { num: 24, den: 1 },
  "25": { num: 25, den: 1 },
  "29.97": { num: 30000, den: 1001 },
  "30": { num: 30, den: 1 },
  "50": { num: 50, den: 1 },
  "59.94": { num: 60000, den: 1001 },
  "60": { num: 60, den: 1 },
};

export function fpsValue(fps: Rational): number {
  return fps.num / fps.den;
}

export function fpsString(fps: Rational): string {
  return fps.den === 1 ? `${fps.num}` : `${fps.num}/${fps.den}`;
}

/** Parse "30000/1001", "29.97" or "30" into a rational. */
export function parseRational(s: string): Rational | null {
  const t = s.trim();
  if (t.includes("/")) {
    const [a, b] = t.split("/").map(Number);
    if (!a || !b || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { num: a, den: b };
  }
  const v = Number(t);
  if (!Number.isFinite(v) || v <= 0) return null;
  for (const r of Object.values(FPS_PRESETS)) {
    if (Math.abs(fpsValue(r) - v) < 0.005) return r;
  }
  return { num: Math.round(v * 1000), den: 1000 };
}

export function framesToSeconds(frames: number, fps: Rational): number {
  return (frames * fps.den) / fps.num;
}

/** Nearest frame for a time in seconds. */
export function secondsToFrames(seconds: number, fps: Rational): number {
  return Math.round((seconds * fps.num) / fps.den);
}

/** Round seconds to microseconds so serialized values are stable. */
export function roundSeconds(s: number): number {
  return Math.round(s * 1e6) / 1e6;
}

/** HH:MM:SS:FF timecode (non-drop-frame). */
export function formatTimecode(frame: number, fps: Rational): string {
  const nominal = Math.round(fpsValue(fps));
  const sign = frame < 0 ? "-" : "";
  let f = Math.abs(Math.round(frame));
  const ff = f % nominal;
  f = Math.floor(f / nominal);
  const ss = f % 60;
  f = Math.floor(f / 60);
  const mm = f % 60;
  const hh = Math.floor(f / 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${sign}${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

/** Short human readable duration like 1:23.4 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "--";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, "0")}` : `${s.toFixed(1)}s`;
}
