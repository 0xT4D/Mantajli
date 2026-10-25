/**
 * Card backdrops: procedural backgrounds for colour clips, so a title card has light, depth and
 * texture instead of a flat fill. One deterministic rasterizer serves the export (engine writes it as
 * a PNG input) and the live preview (canvas ImageData), so both show the same picture.
 *
 * Styles follow what the reference teasers do behind type:
 *  - spotlight: a soft pool of accent light behind the title, falling off to the fill
 *  - studio:    a lit back wall meeting a floor at a horizon (cyclorama), light reflected on the floor
 *  - smoke:     fractal smoke tinted from the fill into the accent, brightest behind the title
 *  - grid:      a perspective floor grid under a glowing horizon (matches the synthwave 3D floor)
 *  - panel:     a UI window (border, header bar, corner brackets, dithered body) on a dark field
 * Every style gets a baked vignette and static grain (`texture`); temporal grain stays an effect.
 */
import { z } from "zod";

export const BACKDROP_STYLES = ["flat", "spotlight", "studio", "smoke", "grid", "panel"] as const;
export type BackdropStyle = (typeof BACKDROP_STYLES)[number];

export const BACKDROP_STYLE_LABELS: Record<BackdropStyle, string> = {
  flat: "Flat colour",
  spotlight: "Spotlight",
  studio: "Studio wall + floor",
  smoke: "Smoke",
  grid: "Horizon grid",
  panel: "UI panel",
};

export const BackdropSchema = z.object({
  style: z.enum(BACKDROP_STYLES).default("flat"),
  /** Light / smoke / line colour; the clip's fill is the base. */
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#ff2bd6"),
  /** Strength of the light (0 = unlit base). */
  light: z.number().min(0).max(1).default(0.6),
  /** Grain, smoke contrast and surface mottling. */
  texture: z.number().min(0).max(1).default(0.35),
  /** Vertical position of the light / horizon, 0 = top, 1 = bottom. */
  focus: z.number().min(0).max(1).default(0.45),
  seed: z.number().int().min(0).max(9999).default(1),
});
export type Backdrop = z.infer<typeof BackdropSchema>;

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Integer hash → [0, 1). */
function hash(x: number, y: number, seed: number): number {
  // Sum of odd-constant products, then murmur3's finaliser (an XOR of the products left column stripes).
  let h = (Math.imul(x | 0, 0x8da6b343) + Math.imul(y | 0, 0xd8163841) + Math.imul(seed | 0, 0xcb1ab31f)) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * f, y * f, seed + o * 101);
    f *= 2.03;
    amp *= 0.5;
  }
  return sum / (1 - Math.pow(0.5, octaves));
}

/** True when the backdrop draws something other than its flat fill. */
export function hasBackdrop(b: Backdrop | undefined): b is Backdrop {
  return !!b && b.style !== "flat";
}

/** Stable key of what a backdrop renders (for caches). */
export function backdropKey(fill: string, b: Backdrop, width: number, height: number): string {
  return [fill, b.style, b.accent, b.light, b.texture, b.focus, b.seed, width, height].join("|");
}

/**
 * Rasterize a backdrop to straight RGBA (opaque). Coordinates are normalised by the frame's short
 * side, so the picture keeps its proportions at any resolution (only the grain is per pixel).
 */
export function renderBackdrop(fill: string, b: Backdrop, width: number, height: number): Uint8ClampedArray {
  const W = Math.max(1, Math.round(width));
  const H = Math.max(1, Math.round(height));
  const out = new Uint8ClampedArray(W * H * 4);
  const base = rgb(fill).map((c) => c / 255) as [number, number, number];
  const acc = rgb(b.accent).map((c) => c / 255) as [number, number, number];
  const s = Math.min(W, H);
  const cx = W / 2 / s;
  const fy = (b.focus * H) / s;
  const light = b.light;
  const tex = b.texture;
  const seed = b.seed;
  // Panel geometry (short-side units): a window centred on the focus line.
  const pw = (W / s) * 0.84;
  const ph = (H / s) * 0.3;
  const px0 = cx - pw / 2;
  const py0 = fy - ph / 2;
  const bar = 0.055;
  const line = Math.max(1.5, s / 400) / s;

  for (let y = 0; y < H; y++) {
    const ny = (y + 0.5) / s;
    for (let x = 0; x < W; x++) {
      const nx = (x + 0.5) / s;
      const dx = nx - cx;
      const dy = ny - fy;
      let r = base[0];
      let g = base[1];
      let bl = base[2];
      // Surface mottling: low-frequency variation so large fields are not dead flat.
      const mott = (fbm(nx * 2.2, ny * 2.2, seed + 7, 3) - 0.5) * 0.16 * tex;
      let glow = 0;
      let lineMix = 0;
      let dim = 1;
      switch (b.style) {
        case "spotlight": {
          const d2 = dx * dx * 1.1 + dy * dy * 1.6;
          glow = light * (0.85 * Math.exp(-d2 / 0.06) + 0.35 * Math.exp(-d2 / 0.35));
          break;
        }
        case "studio": {
          const hz = (b.focus + 0.25) * (H / s);
          if (ny < hz) {
            // Back wall: light from above, a pool on the wall behind the title.
            const d2 = dx * dx * 0.9 + (ny - fy) * (ny - fy) * 0.8;
            glow = light * (0.7 * Math.exp(-d2 / 0.12) + 0.25 * Math.exp(-(dx * dx) / 0.5) * smooth(hz, 0, ny));
          } else {
            // Floor: darker, the wall's pool reflected and stretched towards the viewer.
            const t = (ny - hz) / Math.max(1e-3, H / s - hz);
            dim = 0.55 - 0.25 * t;
            glow = light * 0.45 * Math.exp(-(dx * dx) / (0.05 + 0.25 * t)) * (1 - t) ** 1.5;
            lineMix = light * 0.35 * Math.exp(-((ny - hz) * (ny - hz)) / 0.00004) * Math.exp(-(dx * dx) / 0.4);
          }
          break;
        }
        case "smoke": {
          const wx = fbm(nx * 1.7 + 3.1, ny * 1.7, seed + 11, 4);
          const wy = fbm(nx * 1.7, ny * 1.7 + 5.7, seed + 13, 4);
          const n = fbm(nx * 2.6 + 1.6 * wx, ny * 2.6 + 1.6 * wy, seed, 5);
          const shaped = smooth(0.22 - 0.1 * tex, 0.8, n) ** (1.5 - 0.6 * tex);
          const d2 = dx * dx + dy * dy * 0.7;
          const pool = Math.exp(-d2 / 0.25);
          glow = light * (0.25 * pool + shaped * (0.35 + 0.65 * pool));
          dim = 0.75 + 0.25 * shaped;
          break;
        }
        case "grid": {
          const hz = fy + 0.06;
          const d2 = dx * dx * 0.5 + (ny - hz) * (ny - hz) * 6;
          glow = light * (0.6 * Math.exp(-d2 / 0.05) + 0.2 * Math.exp(-(ny - hz) * (ny - hz) / 0.02));
          if (ny > hz) {
            const depth = ny - hz;
            const z = 0.35 / depth; // distance along the floor
            const gx = (dx * z) / 0.35;
            const fade = smooth(0, 0.12, depth) * Math.exp(-z * 0.08);
            // Distances to the nearest grid line measured on screen (floor distance × its screen scale),
            // so lines keep one width from the horizon to the bottom edge.
            const gxl = Math.abs(gx * 4 - Math.round(gx * 4)) / 4;
            const gzl = Math.abs(z * 1.2 - Math.round(z * 1.2)) / 1.2;
            const xDist = (gxl * 0.35) / z;
            const zDist = (gzl * depth * depth) / 0.35;
            const onX = 1 - smooth(line * 0.5, line * 1.5, xDist);
            const onZ = 1 - smooth(line * 0.5, line * 1.5, zDist);
            lineMix = Math.max(onX, onZ) * fade * (0.35 + 0.65 * light);
            dim = 0.7;
          }
          break;
        }
        case "panel": {
          const d2 = dx * dx + dy * dy;
          glow = light * 0.25 * Math.exp(-d2 / 0.2);
          const inX = nx >= px0 && nx <= px0 + pw;
          const inY = ny >= py0 && ny <= py0 + ph;
          if (inX && inY) {
            const ex = Math.min(nx - px0, px0 + pw - nx);
            const ey = Math.min(ny - py0, py0 + ph - ny);
            const edge = Math.min(ex, ey);
            if (edge < line * 1.6) lineMix = 1;
            else if (ny - py0 < bar) {
              // Header bar with three window buttons on the right.
              lineMix = 0.85;
              const bx = px0 + pw - nx;
              const by = ny - py0;
              for (let k = 0; k < 3; k++) {
                const c0 = 0.02 + k * 0.045;
                if (bx > c0 && bx < c0 + 0.032 && by > 0.012 && by < bar - 0.012) {
                  const inner = bx > c0 + line * 1.4 && bx < c0 + 0.032 - line * 1.4 && by > 0.012 + line * 1.4 && by < bar - 0.012 - line * 1.4;
                  lineMix = inner ? 0.85 : 0.15;
                }
              }
            } else {
              // Dithered body + corner brackets inset from the frame.
              const cell = Math.max(2, Math.round(s / 270));
              const chk = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0;
              dim = 0.55 + (chk ? 0.12 * tex : 0);
              const inset = 0.03;
              const arm = 0.06;
              const bx0 = nx - (px0 + inset);
              const bx1 = px0 + pw - inset - nx;
              const by0 = ny - (py0 + bar + inset);
              const by1 = py0 + ph - inset - ny;
              const nearX = Math.min(Math.abs(bx0), Math.abs(bx1));
              const nearY = Math.min(Math.abs(by0), Math.abs(by1));
              const withinX = Math.min(bx0, bx1) > -line && Math.min(bx0, bx1) < arm;
              const withinY = Math.min(by0, by1) > -line && Math.min(by0, by1) < arm;
              if ((nearX < line && withinY && Math.min(bx0, bx1) > -line) || (nearY < line && withinX && Math.min(by0, by1) > -line)) lineMix = 0.9;
            }
          } else dim = 0.8;
          break;
        }
        default:
          break;
      }
      r = r * dim + mott + acc[0] * glow;
      g = g * dim + mott + acc[1] * glow;
      bl = bl * dim + mott + acc[2] * glow;
      if (lineMix > 0) {
        r += (acc[0] - r) * lineMix;
        g += (acc[1] - g) * lineMix;
        bl += (acc[2] - bl) * lineMix;
      }
      // Baked vignette (radial, by the frame diagonal) and static grain.
      const vx = (x + 0.5) / W - 0.5;
      const vy = (y + 0.5) / H - 0.5;
      const v = 1 - 0.55 * smooth(0.2, 0.75, Math.sqrt(vx * vx + vy * vy));
      const grain = (hash(x, y, seed + 3) - 0.5) * 0.06 * tex;
      const i = (y * W + x) * 4;
      out[i] = Math.round(clamp01(r * v + grain) * 255);
      out[i + 1] = Math.round(clamp01(g * v + grain) * 255);
      out[i + 2] = Math.round(clamp01(bl * v + grain) * 255);
      out[i + 3] = 255;
    }
  }
  return out;
}
