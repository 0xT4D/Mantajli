import type { Easing, SceneKeyframe, Vec3 } from "./schema.js";

/**
 * Camera move presets. Each produces a smooth spline path (scene coordinates,
 * Blender axes: Z up, the default camera looks along +Y) and pathProgress
 * keyframes. The camera keeps looking at its target, so moves stay framed.
 */

export const CAMERA_MOVES = ["orbit", "dollyIn", "dollyOut", "craneUp", "craneDown", "truckLeft", "truckRight"] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

export interface CameraMoveOptions {
  /** Point the camera frames (usually the look-at object's location). */
  target: Vec3;
  /** Camera distance from the target (metres). */
  distance: number;
  /** Camera height above the target. */
  height: number;
  startFrame: number;
  endFrame: number;
  easing: Easing;
  /** Orbit sweep in degrees (negative = clockwise seen from above); 360 = full turn. */
  arc?: number;
  /** Orbit start angle in degrees; 0 = in front of the target (on -Y). */
  startAngle?: number;
  /**
   * Snap-and-settle: instead of one continuous move, travel in equal steps that
   * start on these frames (e.g. beat markers) and take `stepFrames` each,
   * holding still in between.
   */
  stops?: number[];
  stepFrames?: number;
}

export interface CameraMoveResult {
  path: { points: Vec3[]; closed: boolean };
  keyframes: SceneKeyframe[];
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const pt = (x: number, y: number, z: number): Vec3 => [round(x), round(y), round(z)];

/** Points on an arc around `c` at radius r, height h, from a0 to a0 + arc (degrees, 0 = -Y side). */
export function arcPoints(c: Vec3, r: number, h: number, a0: number, arc: number): Vec3[] {
  const steps = Math.max(2, Math.ceil(Math.abs(arc) / 22.5));
  const full = Math.abs(arc) >= 360;
  const n = full ? steps : steps + 1;
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((a0 + (arc * i) / steps) * Math.PI) / 180;
    out.push(pt(c[0] + r * Math.sin(a), c[1] - r * Math.cos(a), c[2] + h));
  }
  return out;
}

export function cameraMove(kind: CameraMove, o: CameraMoveOptions): CameraMoveResult {
  const [cx, cy, cz] = o.target;
  const d = Math.max(0.1, o.distance);
  const h = o.height;
  let points: Vec3[];
  let closed = false;
  switch (kind) {
    case "orbit": {
      const arc = o.arc ?? 90;
      points = arcPoints(o.target, d, h, o.startAngle ?? -arc / 2, arc);
      closed = Math.abs(arc) >= 360;
      break;
    }
    case "dollyIn":
      points = [pt(cx, cy - d * 1.6, cz + h), pt(cx, cy - d * 0.6, cz + h * 0.8)];
      break;
    case "dollyOut":
      points = [pt(cx, cy - d * 0.6, cz + h * 0.8), pt(cx, cy - d * 1.6, cz + h)];
      break;
    case "craneUp":
      points = [pt(cx, cy - d, cz + h * 0.15), pt(cx, cy - d * 0.97, cz + h * 0.65), pt(cx, cy - d * 0.9, cz + h * 1.6)];
      break;
    case "craneDown":
      points = [pt(cx, cy - d * 0.9, cz + h * 1.6), pt(cx, cy - d * 0.97, cz + h * 0.65), pt(cx, cy - d, cz + h * 0.15)];
      break;
    case "truckLeft":
      points = [pt(cx + d * 0.45, cy - d, cz + h), pt(cx - d * 0.45, cy - d, cz + h)];
      break;
    case "truckRight":
      points = [pt(cx - d * 0.45, cy - d, cz + h), pt(cx + d * 0.45, cy - d, cz + h)];
      break;
  }
  return { path: { points, closed }, keyframes: progressKeys(o) };
}

/** pathProgress keyframes: one eased move, or equal steps that start on `stops` and hold between them. */
export function progressKeys(o: Pick<CameraMoveOptions, "startFrame" | "endFrame" | "easing" | "stops" | "stepFrames">): SceneKeyframe[] {
  const stops = [...new Set(o.stops ?? [])].filter((f) => f >= 0).sort((a, b) => a - b);
  if (!stops.length) {
    const end = Math.max(o.startFrame + 1, o.endFrame);
    return [
      { frame: o.startFrame, value: [0], easing: o.easing },
      { frame: end, value: [1], easing: "linear" },
    ];
  }
  const n = stops.length;
  const keys: SceneKeyframe[] = [];
  stops.forEach((f, i) => {
    const step = Math.max(1, Math.min(o.stepFrames ?? 12, (stops[i + 1] ?? Infinity) - f));
    const from = i / n;
    const to = (i + 1) / n;
    // Hold key replaced by the move start when they share a frame.
    if (keys.length && keys[keys.length - 1]!.frame === f) keys.pop();
    keys.push({ frame: f, value: [round(from)], easing: o.easing }, { frame: f + step, value: [round(to)], easing: "hold" });
  });
  return keys;
}
