/**
 * Registries of implemented effects, transitions, text animations and looks.
 *
 * Every entry here is implemented by the FFmpeg composition builder in
 * @mantagli/engine. The UI inspector and the AI tool schemas are generated
 * from these registries, so there are no controls without a renderer.
 */

export type ParamSpec =
  | { key: string; label: string; kind: "number"; min: number; max: number; step: number; default: number; unit?: string }
  | { key: string; label: string; kind: "enum"; options: string[]; default: string }
  | { key: string; label: string; kind: "bool"; default: boolean }
  | { key: string; label: string; kind: "color"; default: string }
  | { key: string; label: string; kind: "asset"; assetKind: "lut"; default: string };

export interface EffectSpec {
  type: string;
  label: string;
  category: "color" | "stylize" | "blur" | "transform" | "motion";
  description: string;
  params: ParamSpec[];
}

/** Motion effects add animation curves (core/animation.ts) instead of filters. */
export const MOTION_EFFECTS = new Set(["shake", "beatPulse"]);

export const EFFECTS: EffectSpec[] = [
  {
    type: "exposure",
    label: "Exposure",
    category: "color",
    description: "Exposure adjustment in photographic stops.",
    params: [{ key: "stops", label: "Exposure", kind: "number", min: -3, max: 3, step: 0.05, default: 0, unit: "EV" }],
  },
  {
    type: "basicColor",
    label: "Contrast / Saturation",
    category: "color",
    description: "Contrast, saturation, brightness and gamma.",
    params: [
      { key: "contrast", label: "Contrast", kind: "number", min: 0, max: 2, step: 0.01, default: 1 },
      { key: "saturation", label: "Saturation", kind: "number", min: 0, max: 3, step: 0.01, default: 1 },
      { key: "brightness", label: "Brightness", kind: "number", min: -0.5, max: 0.5, step: 0.01, default: 0 },
      { key: "gamma", label: "Gamma", kind: "number", min: 0.3, max: 3, step: 0.01, default: 1 },
    ],
  },
  {
    type: "temperature",
    label: "Temperature / Tint",
    category: "color",
    description: "Warm (+) / cool (-) white-balance shift and green (-) / magenta (+) tint.",
    params: [
      { key: "warmth", label: "Temperature", kind: "number", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "tint", label: "Tint", kind: "number", min: -1, max: 1, step: 0.01, default: 0 },
    ],
  },
  {
    type: "tone",
    label: "Shadows / Highlights",
    category: "color",
    description: "Lift or crush shadows and highlights with a tone curve.",
    params: [
      { key: "shadows", label: "Shadows", kind: "number", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "highlights", label: "Highlights", kind: "number", min: -1, max: 1, step: 0.01, default: 0 },
    ],
  },
  {
    type: "splitTone",
    label: "Split Tone",
    category: "color",
    description: "Tint shadows and highlights with separate hues (e.g. teal shadows, orange highlights).",
    params: [
      { key: "shadowHue", label: "Shadow hue", kind: "number", min: 0, max: 360, step: 1, default: 190, unit: "°" },
      { key: "shadowAmount", label: "Shadow amount", kind: "number", min: 0, max: 1, step: 0.01, default: 0 },
      { key: "highlightHue", label: "Highlight hue", kind: "number", min: 0, max: 360, step: 1, default: 30, unit: "°" },
      { key: "highlightAmount", label: "Highlight amount", kind: "number", min: 0, max: 1, step: 0.01, default: 0 },
    ],
  },
  {
    type: "curves",
    label: "Curves Preset",
    category: "color",
    description: "Apply a built-in tone-curve preset.",
    params: [
      {
        key: "preset",
        label: "Preset",
        kind: "enum",
        options: ["medium_contrast", "strong_contrast", "linear_contrast", "increase_contrast", "lighter", "darker", "vintage", "cross_process"],
        default: "medium_contrast",
      },
    ],
  },
  {
    type: "lut",
    label: "3D LUT",
    category: "color",
    description: "Apply an imported .cube / .3dl LUT asset.",
    params: [{ key: "assetId", label: "LUT", kind: "asset", assetKind: "lut", default: "" }],
  },
  {
    type: "vignette",
    label: "Vignette",
    category: "stylize",
    description: "Darken the frame edges.",
    params: [{ key: "amount", label: "Amount", kind: "number", min: 0, max: 1, step: 0.01, default: 0.5 }],
  },
  {
    type: "glow",
    label: "Glow / Bloom",
    category: "stylize",
    description: "Screen-blended blurred copy for a bloom look.",
    params: [
      { key: "strength", label: "Strength", kind: "number", min: 0, max: 1, step: 0.01, default: 0.35 },
      { key: "radius", label: "Radius", kind: "number", min: 1, max: 60, step: 1, default: 18, unit: "px" },
    ],
  },
  {
    type: "chromaticAberration",
    label: "Chromatic Aberration",
    category: "stylize",
    description: "Offset red and blue channels horizontally.",
    params: [{ key: "pixels", label: "Offset", kind: "number", min: 0, max: 20, step: 1, default: 4, unit: "px" }],
  },
  {
    type: "grain",
    label: "Film Grain",
    category: "stylize",
    description: "Temporal luminance noise.",
    params: [{ key: "amount", label: "Amount", kind: "number", min: 0, max: 60, step: 1, default: 12 }],
  },
  {
    type: "blur",
    label: "Gaussian Blur",
    category: "blur",
    description: "Gaussian blur.",
    params: [{ key: "radius", label: "Radius", kind: "number", min: 0, max: 60, step: 0.5, default: 8, unit: "px" }],
  },
  {
    type: "sharpen",
    label: "Sharpen",
    category: "blur",
    description: "Unsharp-mask sharpening.",
    params: [{ key: "amount", label: "Amount", kind: "number", min: 0, max: 3, step: 0.05, default: 0.8 }],
  },
  {
    type: "flip",
    label: "Flip",
    category: "transform",
    description: "Mirror the image.",
    params: [
      { key: "horizontal", label: "Horizontal", kind: "bool", default: true },
      { key: "vertical", label: "Vertical", kind: "bool", default: false },
    ],
  },
  {
    type: "shake",
    label: "Camera Shake",
    category: "motion",
    description: "Smooth random handheld/impact shake of position and rotation. Combine with a slight scale-up to hide the edges.",
    params: [
      { key: "amount", label: "Amount", kind: "number", min: 0, max: 10, step: 0.1, default: 1.5, unit: "% width" },
      { key: "frequency", label: "Frequency", kind: "number", min: 0.5, max: 30, step: 0.5, default: 8, unit: "Hz" },
      { key: "rotation", label: "Rotation", kind: "number", min: 0, max: 15, step: 0.1, default: 1, unit: "°" },
      { key: "seed", label: "Seed", kind: "number", min: 0, max: 999, step: 1, default: 1 },
    ],
  },
  {
    type: "beatPulse",
    label: "Beat Pulse",
    category: "motion",
    description: "Zoom punch on every beat marker inside the clip, decaying back to normal.",
    params: [
      { key: "zoom", label: "Zoom", kind: "number", min: 0, max: 0.5, step: 0.01, default: 0.08 },
      { key: "decay", label: "Decay", kind: "number", min: 1, max: 30, step: 1, default: 8, unit: "frames" },
      { key: "on", label: "Markers", kind: "enum", options: ["beats", "downbeats", "all"], default: "beats" },
    ],
  },
];

export const EFFECT_TYPES = EFFECTS.map((e) => e.type);

export function effectSpec(type: string): EffectSpec | undefined {
  return EFFECTS.find((e) => e.type === type);
}

export type ParamValue = number | string | boolean;

/** Fill defaults, clamp numbers and drop unknown keys. Throws on bad types. */
export function normalizeEffectParams(type: string, params: Record<string, unknown>): Record<string, ParamValue> {
  const spec = effectSpec(type);
  if (!spec) throw new Error(`Unsupported effect type "${type}". Supported: ${EFFECT_TYPES.join(", ")}`);
  const out: Record<string, ParamValue> = {};
  for (const p of spec.params) {
    const v = params[p.key];
    if (v === undefined || v === null) {
      out[p.key] = p.default;
      continue;
    }
    switch (p.kind) {
      case "number": {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`Effect ${type}.${p.key} must be a number`);
        out[p.key] = Math.min(p.max, Math.max(p.min, n));
        break;
      }
      case "enum":
        if (!p.options.includes(String(v))) throw new Error(`Effect ${type}.${p.key} must be one of ${p.options.join(", ")}`);
        out[p.key] = String(v);
        break;
      case "bool":
        out[p.key] = Boolean(v);
        break;
      case "color":
        if (!/^#[0-9a-fA-F]{6}$/.test(String(v))) throw new Error(`Effect ${type}.${p.key} must be a #rrggbb color`);
        out[p.key] = String(v);
        break;
      case "asset":
        out[p.key] = String(v);
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transitions. A transition belongs to the incoming clip and plays over its
// first `duration` frames. The outgoing clip on the same track is held under
// it for that span (extended into its source handle, or frozen if none).

export interface TransitionSpec {
  type: string;
  label: string;
  description: string;
  /** Whether the outgoing clip must remain visible during the transition. */
  needsOutgoing: boolean;
}

export const TRANSITIONS: TransitionSpec[] = [
  { type: "crossfade", label: "Cross Dissolve", description: "Blend from the previous shot.", needsOutgoing: true },
  { type: "dipBlack", label: "Dip to Black", description: "Fade through black.", needsOutgoing: false },
  { type: "flash", label: "Flash (Dip to White)", description: "Fade through white — good on beats.", needsOutgoing: false },
  { type: "slideLeft", label: "Slide Left", description: "Incoming shot slides in from the right.", needsOutgoing: true },
  { type: "slideRight", label: "Slide Right", description: "Incoming shot slides in from the left.", needsOutgoing: true },
  { type: "slideUp", label: "Slide Up", description: "Incoming shot slides in from the bottom.", needsOutgoing: true },
  { type: "slideDown", label: "Slide Down", description: "Incoming shot slides in from the top.", needsOutgoing: true },
  { type: "zoomIn", label: "Zoom Punch", description: "Incoming shot scales down from 130% while fading in.", needsOutgoing: true },
  { type: "wipeLeft", label: "Wipe Left", description: "Soft edge sweeps right to left revealing the incoming shot.", needsOutgoing: true },
  { type: "wipeRight", label: "Wipe Right", description: "Soft edge sweeps left to right revealing the incoming shot.", needsOutgoing: true },
  { type: "wipeUp", label: "Wipe Up", description: "Soft edge sweeps bottom to top revealing the incoming shot.", needsOutgoing: true },
  { type: "wipeDown", label: "Wipe Down", description: "Soft edge sweeps top to bottom revealing the incoming shot.", needsOutgoing: true },
  { type: "iris", label: "Iris Open", description: "Circle grows from the centre revealing the incoming shot.", needsOutgoing: true },
];

export const TRANSITION_TYPES = TRANSITIONS.map((t) => t.type);

// ---------------------------------------------------------------------------
// Text animations (curves in core/animation.ts; typewriter reveals characters, see textReveal).

export const TEXT_ANIMATIONS = ["none", "fade", "slideUp", "slideDown", "slideLeft", "slideRight", "pop", "typewriter"] as const;
export type TextAnimation = (typeof TEXT_ANIMATIONS)[number];

// ---------------------------------------------------------------------------
// Looks: named stacks of effects.

export interface LookSpec {
  id: string;
  label: string;
  description: string;
  effects: { type: string; params: Record<string, ParamValue> }[];
}

export const LOOKS: LookSpec[] = [
  {
    id: "tealOrange",
    label: "Teal & Orange",
    description: "Blockbuster split tone with gentle contrast.",
    effects: [
      { type: "basicColor", params: { contrast: 1.12, saturation: 1.1 } },
      { type: "splitTone", params: { shadowHue: 190, shadowAmount: 0.35, highlightHue: 30, highlightAmount: 0.3 } },
      { type: "vignette", params: { amount: 0.35 } },
    ],
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk",
    description: "Purple/teal neon grade, punchy contrast, bloom and channel split.",
    effects: [
      { type: "basicColor", params: { contrast: 1.2, saturation: 1.35, gamma: 0.95 } },
      { type: "splitTone", params: { shadowHue: 280, shadowAmount: 0.45, highlightHue: 180, highlightAmount: 0.35 } },
      { type: "glow", params: { strength: 0.3, radius: 20 } },
      { type: "chromaticAberration", params: { pixels: 3 } },
      { type: "vignette", params: { amount: 0.45 } },
    ],
  },
  {
    id: "noir",
    label: "Noir",
    description: "High-contrast black and white with grain.",
    effects: [
      { type: "basicColor", params: { contrast: 1.35, saturation: 0 } },
      { type: "curves", params: { preset: "strong_contrast" } },
      { type: "grain", params: { amount: 16 } },
      { type: "vignette", params: { amount: 0.6 } },
    ],
  },
  {
    id: "vintageFilm",
    label: "Vintage Film",
    description: "Warm, faded film stock.",
    effects: [
      { type: "curves", params: { preset: "vintage" } },
      { type: "temperature", params: { warmth: 0.25 } },
      { type: "grain", params: { amount: 10 } },
      { type: "vignette", params: { amount: 0.4 } },
    ],
  },
  {
    id: "cleanCommercial",
    label: "Clean Commercial",
    description: "Bright, crisp and slightly saturated.",
    effects: [
      { type: "exposure", params: { stops: 0.15 } },
      { type: "basicColor", params: { contrast: 1.08, saturation: 1.12 } },
      { type: "sharpen", params: { amount: 0.5 } },
    ],
  },
  {
    id: "bleachBypass",
    label: "Bleach Bypass",
    description: "Desaturated, metallic, high contrast.",
    effects: [
      { type: "basicColor", params: { contrast: 1.3, saturation: 0.45 } },
      { type: "tone", params: { shadows: -0.2, highlights: 0.15 } },
    ],
  },
];

export function lookSpec(id: string): LookSpec | undefined {
  return LOOKS.find((l) => l.id === id);
}

/** Line height (× font size) for 2D text, shared by export and live preview. */
export const TEXT_LINE_HEIGHT = 1.2;
