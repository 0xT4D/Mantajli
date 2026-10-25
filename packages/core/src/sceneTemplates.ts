import { makeSceneObject, type SceneObjectInit } from "./factories.js";
import { newId } from "./ids.js";
import { arcPoints, progressKeys } from "./cameraRigs.js";
import { MATERIAL_PRESETS, SceneSchema, type Easing, type Scene, type SceneObject, type Vec3 } from "./schema.js";

/**
 * Parameterised, deterministic 3D scene templates. Coordinates are Blender's
 * (Z up, camera looking along +Y when rotated 90° about X).
 */

export interface SceneTemplateParams {
  name?: string;
  durationFrames: number;
  text?: string;
  /** Primary and secondary accent colours (lights / emission). */
  accentA?: string;
  accentB?: string;
  material?: (typeof MATERIAL_PRESETS)[number];
  modelAssetId?: string;
  particles?: boolean;
  fog?: number;
  /** Output frame aspect (width / height), for framing that must match the edit (portals). */
  aspect?: number;
  /** Image/video shown on the template's screen, and its aspect (width / height). */
  mediaAssetId?: string;
  mediaAspect?: number;
  /** Number of stations (turntable). */
  count?: number;
  /** Frames where snap-and-settle camera moves start (e.g. beat markers). */
  stops?: number[];
}

/**
 * Camera distance at which a w x h screen exactly fills the frame the way a
 * "fill"-fit clip does (the tighter side matches), for a lens of `focal` mm and
 * Blender's automatic sensor fit (36 mm across the longer frame side).
 */
export function fillDistance(w: number, h: number, focal: number, aspect: number): number {
  const tanH = aspect >= 1 ? 18 / focal : (18 * aspect) / focal;
  const tanV = aspect >= 1 ? 18 / (focal * aspect) : 18 / focal;
  return w / h >= aspect ? h / 2 / tanV : w / 2 / tanH;
}

export interface SceneTemplateSpec {
  id: string;
  label: string;
  description: string;
  build(p: SceneTemplateParams): Scene;
}

const cam = (
  location: [number, number, number],
  rotation: [number, number, number],
  focalLength = 50,
  extra: Partial<SceneObjectInit> = {},
): SceneObject =>
  makeSceneObject({ kind: "camera", name: "Camera", location, rotation, camera: { focalLength, dof: false, focusDistance: 8, fStop: 2.8 }, ...extra });

const areaLight = (name: string, location: [number, number, number], rotation: [number, number, number], color: string, energy: number, size = 3) =>
  makeSceneObject({ kind: "light", name, location, rotation, light: { type: "area", color, energy, size } });

const particles = (color: string, n = 350, emission = 6) =>
  makeSceneObject({
    kind: "particles",
    name: "Dust",
    location: [0, 2, 0],
    particles: { count: n, size: 0.025, color, emission, area: [9, 7, 5], drift: 0.6, seed: 7 },
  });

function finish(p: SceneTemplateParams, template: string, objects: SceneObject[], extra: Partial<Scene> = {}): Scene {
  const camera = objects.find((o) => o.kind === "camera");
  return SceneSchema.parse({
    id: newId("scn"),
    name: p.name ?? template,
    durationFrames: p.durationFrames,
    template,
    activeCameraId: camera?.id,
    objects,
    ...extra,
  });
}

/**
 * 3D text size that fits the longest line of `body` in `fraction` of the frame width, seen
 * from `distance` m with a `focal` mm lens (Blender fits the 36 mm sensor to the wider side).
 * Bold capitals advance about 0.42 x size per character (measured in renders).
 */
function fitTextSize(body: string, maxSize: number, distance: number, focal: number, aspect: number, letterSpacing = 1, fraction = 0.8): number {
  const longest = Math.max(1, ...body.split("\n").map((l) => l.length));
  const halfWidth = distance * (18 / focal) * Math.min(1, aspect) * fraction;
  return Math.min(maxSize, (2 * halfWidth) / (longest * 0.42 * letterSpacing));
}

export const SCENE_TEMPLATES: SceneTemplateSpec[] = [
  {
    id: "chromeTitle",
    label: "3D Chrome Title",
    description: "Extruded chrome typography floating in darkness with a slow camera push-in, coloured rim lights, studio reflections and glowing particles.",
    build(p) {
      const a = p.accentA ?? "#8a2be2";
      const b = p.accentB ?? "#00e5ff";
      const d = p.durationFrames;
      const body = p.text ?? "TITLE";
      // Fits the frame at the end of the push-in (camera 8.5 m away), e.g. long titles in 9:16.
      const size = fitTextSize(body, 1.4, 8.5, 50, p.aspect ?? 16 / 9, 1.05);
      const text = makeSceneObject({
        kind: "text",
        name: "Title",
        location: [0, 0, 0],
        rotation: [90, 0, 0],
        text: { body, size, extrude: 0.18 * (size / 1.4), bevel: 0.03 * (size / 1.4), align: "center", letterSpacing: 1.05 },
        material: { preset: p.material ?? "chrome", baseColor: "#e8e8f0", metallic: 1, roughness: 0.08, emissionColor: "#000000", emissionStrength: 0, transmission: 0 },
        animation: [
          { property: "rotation", keyframes: [{ frame: 0, value: [90, 0, -14], easing: "easeOut" }, { frame: d - 1, value: [90, 0, 6], easing: "linear" }] },
          { property: "scale", keyframes: [{ frame: 0, value: [0.85, 0.85, 0.85], easing: "easeOut" }, { frame: Math.min(d - 1, Math.round(d * 0.4)), value: [1, 1, 1], easing: "linear" }] },
        ],
      });
      const camera = cam([0, -13, 0.6], [88, 0, 0], 50, {
        camera: { focalLength: 50, dof: true, focusDistance: 11, fStop: 2.0, trackTargetId: text.id },
        animation: [
          { property: "location", keyframes: [{ frame: 0, value: [-1.2, -14, 1.2], easing: "easeInOut" }, { frame: d - 1, value: [0.6, -8.5, 0.3], easing: "linear" }] },
          { property: "focusDistance", keyframes: [{ frame: 0, value: [14], easing: "easeInOut" }, { frame: d - 1, value: [8.5], easing: "linear" }] },
        ],
      });
      const objs = [
        text,
        camera,
        areaLight("Key A", [-6, -4, 3], [60, 0, -55], a, 1600, 4),
        areaLight("Key B", [6, -4, 3], [60, 0, 55], b, 1600, 4),
        // High and behind, aimed at the title so its floor reflection stays out of frame.
        areaLight("Rim", [0, 4, 6], [-33.7, 0, 0], "#ffffff", 700, 4),
      ];
      if (p.particles !== false) objs.push(particles(b));
      // Fog absorbs the reflection band, so chrome titles default to clear air.
      return finish(p, "chromeTitle", objs, { world: { color: "#030308", strength: 0.6, fog: p.fog ?? 0, reflections: 1.6 } });
    },
  },
  {
    id: "productTurntable",
    label: "Product Turntable",
    description: "Imported model (or a rounded cube) rotating 360° on a reflective floor with three-point lighting.",
    build(p) {
      const d = p.durationFrames;
      const hero: SceneObject = p.modelAssetId
        ? makeSceneObject({
            kind: "model",
            name: "Product",
            model: { assetId: p.modelAssetId },
            // A chosen material preset overrides the model's own materials.
            ...(p.material ? { material: { preset: p.material, baseColor: p.accentA ?? "#c0c0c0", metallic: 1, roughness: 0.2, emissionColor: "#000000", emissionStrength: 0, transmission: 0 } } : {}),
          })
        : makeSceneObject({
            kind: "mesh",
            name: "Product",
            location: [0, 0, 0],
            mesh: { primitive: "roundedCube", size: 1.6, smooth: true },
            material: { preset: p.material ?? "carPaint", baseColor: p.accentA ?? "#c0182a", metallic: 0.4, roughness: 0.25, emissionColor: "#000000", emissionStrength: 0, transmission: 0 },
          });
      hero.animation = [{ property: "rotation", keyframes: [{ frame: 0, value: [0, 0, 0], easing: "linear" }, { frame: d, value: [0, 0, 360], easing: "linear" }] }];
      const floor = makeSceneObject({
        kind: "mesh",
        name: "Floor",
        location: [0, 0, -1],
        scale: [20, 20, 1],
        mesh: { primitive: "plane", size: 1, smooth: false },
        material: { preset: "custom", baseColor: "#060608", metallic: 0, roughness: 0.6, emissionColor: "#000000", emissionStrength: 0, transmission: 0 },
      });
      return finish(p, "productTurntable", [
        hero,
        floor,
        cam([0, -7.5, 1.6], [78, 0, 0], 60, { camera: { focalLength: 60, dof: true, focusDistance: 7.5, fStop: 4, trackTargetId: hero.id } }),
        areaLight("Key", [-4, -4, 4], [50, 0, -45], "#fff4e8", 1200, 3),
        areaLight("Fill", [5, -3, 2], [70, 0, 60], p.accentB ?? "#bcd6ff", 400, 5),
        areaLight("Rim", [0, 5, 3], [-55, 0, 0], "#ffffff", 900, 4),
      ], { world: { color: "#0a0a0d", strength: 0.4, fog: 0, reflections: 1.2 } });
    },
  },
  {
    id: "neonFlythrough",
    label: "Neon Fly-through",
    description: "Camera glides down a corridor of dark pillars with emissive neon strips.",
    build(p) {
      const d = p.durationFrames;
      const a = p.accentA ?? "#ff2bd6";
      const b = p.accentB ?? "#00e5ff";
      const objs: SceneObject[] = [];
      for (let i = 0; i < 10; i++) {
        for (const side of [-1, 1]) {
          const y = i * 4;
          objs.push(
            makeSceneObject({
              kind: "mesh",
              name: `Pillar ${i}${side < 0 ? "L" : "R"}`,
              location: [side * 3.2, y, 1.5],
              scale: [0.4, 0.4, 3],
              mesh: { primitive: "cube", size: 1, smooth: false },
              material: { preset: "custom", baseColor: "#0d0d12", metallic: 0.5, roughness: 0.35, emissionColor: "#000000", emissionStrength: 0, transmission: 0 },
            }),
            makeSceneObject({
              kind: "mesh",
              name: `Neon ${i}${side < 0 ? "L" : "R"}`,
              location: [side * 2.75, y, 1.5],
              scale: [0.04, 0.04, 2.6],
              mesh: { primitive: "cube", size: 1, smooth: false },
              material: { preset: "neon", baseColor: "#000000", metallic: 0, roughness: 0.5, emissionColor: (i + (side > 0 ? 1 : 0)) % 2 ? a : b, emissionStrength: 25, transmission: 0 },
            }),
          );
        }
      }
      objs.push(
        makeSceneObject({
          kind: "mesh",
          name: "Ground",
          location: [0, 18, 0],
          scale: [12, 30, 1],
          mesh: { primitive: "plane", size: 1, smooth: false },
          material: { preset: "custom", baseColor: "#050507", metallic: 0.8, roughness: 0.12, emissionColor: "#000000", emissionStrength: 0, transmission: 0 },
        }),
        cam([0, -6, 1.2], [88, 0, 0], 28, {
          animation: [
            { property: "location", keyframes: [{ frame: 0, value: [0, -6, 1.1], easing: "easeIn" }, { frame: d - 1, value: [0, 26, 1.6], easing: "linear" }] },
            { property: "rotation", keyframes: [{ frame: 0, value: [88, 0, 0], easing: "easeInOut" }, { frame: d - 1, value: [90, 6, 0], easing: "linear" }] },
          ],
        }),
      );
      if (p.particles !== false) objs.push(particles(b, 500, 8));
      return finish(p, "neonFlythrough", objs, { world: { color: "#020205", strength: 0.3, fog: p.fog ?? 0.08, reflections: 0 } });
    },
  },
  {
    id: "particleBackdrop",
    label: "Particle Backdrop",
    description: "Atmospheric floating particles with a slow drifting camera — ideal behind titles.",
    build(p) {
      const d = p.durationFrames;
      return finish(p, "particleBackdrop", [
        particles(p.accentA ?? "#9db7ff", 900, 10),
        cam([0, -10, 0], [90, 0, 0], 35, {
          camera: { focalLength: 35, dof: true, focusDistance: 9, fStop: 1.4 },
          animation: [{ property: "location", keyframes: [{ frame: 0, value: [-0.8, -10, -0.3], easing: "linear" }, { frame: d - 1, value: [0.8, -8.8, 0.3], easing: "linear" }] }],
        }),
        areaLight("Glow", [0, 4, 2], [-60, 0, 0], p.accentB ?? "#6a5cff", 600, 8),
      ], { world: { color: "#040408", strength: 0.5, fog: p.fog ?? 0.1, reflections: 0 } });
    },
  },
  {
    id: "empty",
    label: "Empty Stage",
    description: "A camera, a key light and nothing else.",
    build(p) {
      return finish(p, "empty", [cam([0, -10, 1], [85, 0, 0], 50), areaLight("Key", [-4, -4, 5], [45, 0, -40], "#ffffff", 1000, 4)]);
    },
  },
];

// ---------------------------------------------------------------- reference-inspired templates
// (see REFERENCE_VIDEO_ANALYSIS.md): portal into a screen, turntable stations
// with snap-and-settle moves, synthwave horizon, treasure hoard, stage reveal,
// two-tone metal title.

type MatInit = Partial<NonNullable<SceneObject["material"]>>;
const mat = (m: MatInit) => ({ preset: "custom" as const, baseColor: "#cccccc", metallic: 0, roughness: 0.5, emissionColor: "#000000", emissionStrength: 0, transmission: 0, ...m });
const glow = (color: string, strength: number): MatInit => ({ baseColor: "#000000", emissionColor: color, emissionStrength: strength, roughness: 0.6 });
const box = (name: string, location: Vec3, scale: Vec3, m: MatInit, primitive: "cube" | "roundedCube" | "cylinder" | "sphere" | "plane" = "cube", rotation: Vec3 = [0, 0, 0]) =>
  makeSceneObject({ kind: "mesh", name, location, rotation, scale, mesh: { primitive, size: 1, smooth: primitive !== "cube" && primitive !== "plane" }, material: mat(m) });
const spot = (name: string, location: Vec3, rotation: Vec3, color: string, energy: number, spotSize = 35, spotBlend = 0.4) =>
  makeSceneObject({ kind: "light", name, location, rotation, light: { type: "spot", color, energy, size: 0.15, spotSize, spotBlend } });
/** Camera fields for moving along a path with eased (or stepped) progress. */
const onPath = (points: Vec3[], startFrame: number, endFrame: number, easing: Easing, stops?: number[], stepFrames?: number): Partial<SceneObjectInit> => ({
  location: [0, 0, 0],
  path: { points, closed: false, followTangent: false },
  animation: [{ property: "pathProgress", keyframes: progressKeys({ startFrame, endFrame, easing, stops, stepFrames }) }],
});
const lookTarget = (location: Vec3) => makeSceneObject({ kind: "mesh", name: "Look target", visible: false, location, mesh: { primitive: "cube", size: 0.1, smooth: false } });

SCENE_TEMPLATES.push(
  {
    id: "arcadePortal",
    label: "Arcade Portal",
    description:
      "A row of neon arcade cabinets; the camera pushes in and flies into the centre screen, ending exactly where the screen fills the frame. Show the next clip on that screen (mediaAssetId) and cut to it on the last frame for a seamless portal transition.",
    build(p) {
      const d = p.durationFrames;
      const a = p.accentA ?? "#1de9b6";
      const b = p.accentB ?? "#ff2bd6";
      const aspect = p.aspect ?? 9 / 16;
      const objs: SceneObject[] = [];
      const screenZ = 1.62;
      // The screen fits the cabinet face (at most 0.96 x 1.0 m) whatever the media aspect.
      const mediaAspect = p.mediaAspect ?? 4 / 3;
      const screenW = Math.min(0.96, 1.0 * mediaAspect);
      const screenH = screenW / mediaAspect;
      const front = -0.525;
      for (let i = -2; i <= 2; i++) {
        const x = i * 1.75;
        const y = Math.abs(i) * 0.35;
        const n = i + 3;
        objs.push(
          box(`Cabinet ${n}`, [x, y, 1.3], [1.3, 1, 2.6], { baseColor: "#3a2470", metallic: 0.35, roughness: 0.35 }, "roundedCube"),
          box(`Marquee ${n}`, [x, y - 0.52, 2.38], [1.12, 0.04, 0.32], glow(i % 2 ? a : b, 7)),
          box(`Trim L ${n}`, [x - 0.66, y - 0.51, 1.3], [0.035, 0.035, 2.5], glow(i % 2 ? b : a, 14)),
          box(`Trim R ${n}`, [x + 0.66, y - 0.51, 1.3], [0.035, 0.035, 2.5], glow(i % 2 ? b : a, 14)),
          box(`Panel ${n}`, [x, y - 0.62, 1.02], [1.15, 0.45, 0.12], { baseColor: "#4b2c8c", roughness: 0.4 }),
          box(`Button ${n}`, [x + 0.25, y - 0.82, 1.1], [0.12, 0.12, 0.05], glow(i % 2 ? b : a, 5), "cylinder"),
        );
        // Attract mode: every cabinet plays the media (the side ones dimmer); the centre one is the portal.
        if (p.mediaAssetId)
          objs.push(makeSceneObject({ kind: "media", name: i === 0 ? "Screen" : `Screen ${n}`, location: [x, y + front, screenZ], media: { assetId: p.mediaAssetId, width: screenW, emission: i === 0 ? 1 : 0.55, sourceIn: 0, loop: true } }));
        else objs.push(box(`Screen ${n}`, [x, y + front + 0.003, screenZ], [screenW, screenH, 1], glow(i % 2 ? b : a, i === 0 ? 1.6 : 0.7), "plane", [90, 0, 0]));
      }
      objs.push(
        box("Floor", [0, 0, 0], [60, 60, 1], { baseColor: "#07060c", metallic: 0.4, roughness: 0.22 }, "plane"),
        box("Back wall", [0, 4, 4], [60, 8, 1], { baseColor: "#0a0614", roughness: 0.8 }, "plane", [90, 0, 0]),
        areaLight("Fill magenta", [-4, -3, 3.5], [60, 0, -50], b, 700, 4),
        areaLight("Fill teal", [4, -3, 3.5], [60, 0, 50], a, 700, 4),
        areaLight("Top", [0, -1.5, 5.5], [10, 0, 0], "#e8e0ff", 500, 7),
      );
      const focal = 32;
      // End exactly where the screen fills the frame like a "fill"-fit clip.
      const endY = front - fillDistance(screenW, screenH, focal, aspect);
      const start: Vec3 = [0, -5.4, 1.8];
      // A steady push for ~80 % of the shot, then an accelerating plunge into the screen.
      const plunge = Math.max(1, Math.round(d * 0.8));
      const pk = (f: number, v: number, easing: Easing) => ({ frame: f, value: [v], easing });
      const camera = cam([0, 0, 0], [90, 0, 0], focal, {
        camera: { focalLength: focal, dof: true, focusDistance: 8, fStop: 2.4 },
        location: [0, 0, 0],
        path: { points: [start, [0, endY, screenZ]], closed: false, followTangent: false },
        animation: [{ property: "pathProgress", keyframes: [pk(0, 0, "easeOut"), pk(plunge, 0.42, "expoIn"), pk(d - 1, 1, "linear")] }],
      });
      // Focus tracks the screen: the path is straight, so distance is linear in progress.
      const dist = (u: number) => front - (start[1] + (endY - start[1]) * u);
      camera.animation.push({ property: "focusDistance", keyframes: [pk(0, dist(0), "easeOut"), pk(plunge, dist(0.42), "expoIn"), pk(d - 1, dist(1), "linear")] });
      objs.push(camera);
      if (p.particles !== false) objs.push(particles(a, 250, 5));
      return finish(p, "arcadePortal", objs, { world: { color: "#050309", strength: 0.35, fog: p.fog ?? 0.08, reflections: 0.4 } });
    },
  },
  {
    id: "turntableStage",
    label: "Turntable Stations",
    description:
      "Circular neon stage with stations (primitives, or copies of an imported model) around the edge; the camera snaps from station to station and settles (expo ease). Put each station's title on the timeline; pass stops (beat frames) to time the snaps.",
    build(p) {
      const d = p.durationFrames;
      const a = p.accentA ?? "#1de9b6";
      const b = p.accentB ?? "#ffc356";
      const n = Math.max(2, Math.min(8, p.count ?? 4));
      const objs: SceneObject[] = [
        box("Platform", [0, 0, -0.15], [6.4, 6.4, 0.3], { baseColor: "#0b0e14", metallic: 0.5, roughness: 0.32 }, "cylinder"),
        box("Platform rim", [0, 0, -0.17], [6.5, 6.5, 0.06], glow(a, 6), "cylinder"),
        box("Floor", [0, 0, -0.32], [80, 80, 1], { baseColor: "#04060a", roughness: 0.5, emissionColor: a, emissionStrength: 3, pattern: "grid", patternScale: 1.5, patternLineWidth: 0.025 }, "plane"),
      ];
      const heroes: [string, NonNullable<SceneObject["material"]>["preset"]][] = [
        ["roundedCube", "carPaint"], ["sphere", "chrome"], ["torus", "gold"], ["cone", "glass"],
        ["cylinder", "gold"], ["monkey", "chrome"], ["roundedCube", "gold"], ["sphere", "carPaint"],
      ];
      for (let k = 0; k < n; k++) {
        const ang = (k * 360) / n;
        const x = 2.1 * Math.sin((ang * Math.PI) / 180);
        const y = -2.1 * Math.cos((ang * Math.PI) / 180);
        objs.push(
          box(`Pedestal ${k + 1}`, [x, y, 0.1], [1.1, 1.1, 0.2], { baseColor: "#121822", metallic: 0.6, roughness: 0.3 }, "cylinder"),
          box(`Pedestal ring ${k + 1}`, [x, y, 0.005], [1.25, 1.25, 0.02], glow(a, 6), "cylinder"),
        );
        const [prim, preset] = heroes[k % heroes.length]!;
        objs.push(
          p.modelAssetId
            ? makeSceneObject({ kind: "model", name: `Station ${k + 1}`, location: [x, y, 0.75], scale: [0.45, 0.45, 0.45], rotation: [0, 0, ang], model: { assetId: p.modelAssetId } })
            : makeSceneObject({
                kind: "mesh",
                name: `Station ${k + 1}`,
                location: [x, y, 0.75],
                rotation: [0, 0, ang + 20],
                mesh: { primitive: prim as "sphere", size: 0.85, smooth: true },
                material: mat({ preset, baseColor: preset === "carPaint" ? "#c0182a" : b, metallic: 1, roughness: 0.2 }),
              }),
        );
      }
      const target = lookTarget([0, 0, 0.55]);
      // One snap per station after the first: evenly spaced unless stops are given.
      const stops = p.stops?.length ? p.stops.slice(0, n - 1) : Array.from({ length: n - 1 }, (_, k) => Math.round(((k + 1) * d) / n) - 9);
      const camera = cam([0, 0, 0], [80, 0, 0], 35, {
        camera: { focalLength: 35, dof: true, focusDistance: 4.6, fStop: 2.8, trackTargetId: target.id },
        location: [0, 0, 0],
        path: { points: arcPoints([0, 0, 0.55], 6.6, 1.55, 0, (360 * stops.length) / n), closed: false, followTangent: false },
        animation: [{ property: "pathProgress", keyframes: progressKeys({ startFrame: 0, endFrame: d - 1, easing: "expoOut", stops, stepFrames: 20 }) }],
      });
      objs.push(
        target,
        camera,
        areaLight("Overhead", [0, 0, 6], [0, 0, 0], "#fff4e6", 2600, 7),
        spot("Key spot", [0, -3, 7], [25, 0, 0], "#fff1dc", 2500, 45, 0.6),
        areaLight("Rim", [0, 6, 4], [-60, 0, 0], a, 800, 6),
      );
      if (p.particles !== false) objs.push(particles(a, 300, 4));
      return finish(p, "turntableStage", objs, { world: { color: "#020305", strength: 0.3, fog: p.fog ?? 0.06, reflections: 1.2 } });
    },
  },
  {
    id: "synthwaveHorizon",
    label: "Synthwave Horizon",
    description: "Endless neon grid floor, a huge glowing sun and dark mountains; the camera cruises low over the grid. A retro backdrop for titles and menus.",
    build(p) {
      const d = p.durationFrames;
      const a = p.accentA ?? "#ff2bd6";
      const b = p.accentB ?? "#1de9b6";
      return finish(
        p,
        "synthwaveHorizon",
        [
          box("Grid floor", [0, 150, 0], [400, 400, 1], { baseColor: "#030108", roughness: 0.4, emissionColor: b, emissionStrength: 5, pattern: "grid", patternScale: 2.5, patternLineWidth: 0.035 }, "plane"),
          makeSceneObject({ kind: "mesh", name: "Sun", location: [0, 230, 26], mesh: { primitive: "sphere", size: 90, smooth: true }, material: mat(glow(a, 1.6)) }),
          makeSceneObject({
            kind: "scatter",
            name: "Mountains",
            location: [0, 170, -2],
            scatter: { primitive: "crystal", distribution: "grid", count: 26, area: [150, 1, 0], size: 42, sizeJitter: 0.45, rotationJitter: 0.04, seed: 3 },
            material: mat({ baseColor: "#0c0418", roughness: 0.85, emissionColor: a, emissionStrength: 0.15 }),
          }),
          cam([0, 0, 0], [87, 0, 0], 28, onPath([[0, -10, 1.3], [0, 26, 1.3]], 0, d - 1, "linear")),
        ],
        { world: { color: "#0d0418", strength: 0.6, fog: p.fog ?? 0.015, reflections: 0 } },
      );
    },
  },
  {
    id: "treasureHoard",
    label: "Treasure Hoard",
    description: "A heap of thousands of gold coins with glowing crystal clusters under a volumetric spotlight; slow push-in and crane down. Hero backdrop for a title.",
    build(p) {
      const d = p.durationFrames;
      const a = p.accentA ?? "#8a2bff";
      const b = p.accentB ?? "#1de9b6";
      const gold = mat({ preset: "gold", baseColor: "#ffc356", metallic: 1, roughness: 0.3 });
      const objs: SceneObject[] = [
        makeSceneObject({ kind: "scatter", name: "Coins", scatter: { primitive: "coin", distribution: "pile", count: 2600, area: [2.4, 2.4, 1.15], size: 0.17, sizeJitter: 0.1, rotationJitter: 1, seed: 11 }, material: gold }),
        makeSceneObject({ kind: "scatter", name: "Loose coins", scatter: { primitive: "coin", distribution: "disc", count: 260, area: [4.2, 3, 0], size: 0.17, sizeJitter: 0.1, rotationJitter: 0.15, seed: 12 }, material: gold }),
        makeSceneObject({
          kind: "scatter",
          name: "Crystals L",
          location: [-2.9, 0.4, 0],
          scatter: { primitive: "crystal", distribution: "disc", count: 8, area: [0.7, 0.5, 0], size: 1.5, sizeJitter: 0.4, rotationJitter: 0.3, seed: 4 },
          material: mat({ baseColor: "#2a0f5a", roughness: 0.12, transmission: 0.2, emissionColor: a, emissionStrength: 3 }),
        }),
        makeSceneObject({
          kind: "scatter",
          name: "Crystals R",
          location: [2.9, 0.6, 0],
          scatter: { primitive: "crystal", distribution: "disc", count: 7, area: [0.7, 0.5, 0], size: 1.3, sizeJitter: 0.4, rotationJitter: 0.3, seed: 5 },
          material: mat({ baseColor: "#0a3b36", roughness: 0.12, transmission: 0.2, emissionColor: b, emissionStrength: 3 }),
        }),
        box("Floor", [0, 0, 0], [60, 60, 1], { baseColor: "#020304", metallic: 0.3, roughness: 0.35, emissionColor: b, emissionStrength: 0.25, pattern: "grid", patternScale: 0.9, patternLineWidth: 0.03 }, "plane"),
        spot("Top spot", [0, -0.5, 9], [3, 0, 0], "#ffd9a0", 16000, 28, 0.5),
        areaLight("Teal rim", [0, 5, 3], [-65, 0, 0], b, 150, 8),
        // Broad warm light straight above: flat coins mirror it, so their tops read gold, not olive.
        areaLight("Warm top", [0, -0.5, 6.5], [0, 0, 0], "#ffd59a", 2600, 5),
        areaLight("Front fill", [0, -8, 3], [70, 0, 0], "#ffe8c8", 400, 6),
      ];
      for (let i = 0; i < 22; i++) objs.push(box(`Curtain ${i + 1}`, [-10.5 + i, 5.5 + (i % 2) * 0.3, 4], [0.75, 0.6, 8], { baseColor: "#0f4a4a", roughness: 0.55 }, "cylinder"));
      const target = lookTarget([0, 0, 0.7]);
      objs.push(target, cam([0, 0, 0], [80, 0, 0], 35, { camera: { focalLength: 35, dof: true, focusDistance: 8, fStop: 2.2, trackTargetId: target.id }, ...onPath([[0, -10.5, 3.4], [0, -7.6, 2.1]], 0, d - 1, "easeOut") }));
      if (p.particles !== false) objs.push(particles("#ffd9a0", 260, 4));
      return finish(p, "treasureHoard", objs, { world: { color: "#020304", strength: 0.25, fog: p.fog ?? 0.07, reflections: 2.5 } });
    },
  },
  {
    id: "stageReveal",
    label: "Stage Reveal",
    description:
      "Starts with a big stage screen filling the frame (show a clip on it with mediaAssetId), then pulls back to reveal the auditorium: stage, uplit walls and rows of audience. The reverse portal: cut from the clip into this scene.",
    build(p) {
      const d = p.durationFrames;
      const a = p.accentA ?? "#8a5cff";
      const aspect = p.aspect ?? 9 / 16;
      const screenW = 6.4;
      const screenH = screenW / (p.mediaAspect ?? 16 / 9);
      const screenY = 4;
      const screenZ = 2.9;
      const objs: SceneObject[] = [
        p.mediaAssetId
          ? makeSceneObject({ kind: "media", name: "Screen", location: [0, screenY, screenZ], media: { assetId: p.mediaAssetId, width: screenW, emission: 1, sourceIn: 0, loop: true } })
          : box("Screen", [0, screenY, screenZ], [screenW, screenH, 1], glow("#9fd8ff", 1.4), "plane", [90, 0, 0]),
        box("Stage", [0, 2.2, 0.25], [9, 5, 0.5], { baseColor: "#121216", metallic: 0.2, roughness: 0.35 }, "cylinder"),
        box("Stage edge", [0, 2.2, 0.47], [9.06, 5.04, 0.03], glow("#f2f2ff", 0.8), "cylinder"),
        box("Back wall", [0, screenY + 0.3, 4], [30, 10, 1], { baseColor: "#17161c", roughness: 0.85 }, "plane", [90, 0, 0]),
        box("Floor", [0, 0, 0], [60, 60, 1], { baseColor: "#0b0b0e", roughness: 0.6 }, "plane"),
        makeSceneObject({
          kind: "scatter",
          name: "Seats",
          location: [0, -7, 0.3],
          scatter: { primitive: "roundedCube", distribution: "grid", count: 84, area: [7, 2.8, 0], size: 0.62, sizeJitter: 0, rotationJitter: 0, seed: 2 },
          material: mat({ baseColor: "#9b1622", roughness: 0.55 }),
        }),
        makeSceneObject({
          kind: "scatter",
          name: "Audience",
          location: [0, -6.85, 1.02],
          scatter: { primitive: "sphere", distribution: "grid", count: 84, area: [7, 2.8, 0], size: 0.36, sizeJitter: 0.12, rotationJitter: 0, seed: 2 },
          material: mat({ baseColor: "#0d0d10", roughness: 0.8 }),
        }),
        spot("Uplight L", [-4.2, 3.9, 0.3], [-20, 0, 0], a, 900, 40, 0.6),
        spot("Uplight R", [4.2, 3.9, 0.3], [-20, 0, 0], a, 900, 40, 0.6),
        spot("Stage key", [0, -2, 8], [30, 0, 0], "#ffffff", 1200, 30, 0.5),
        areaLight("House", [0, -7, 6], [0, 0, 0], "#ffe2c4", 900, 12),
        spot("Wall wash", [0, -1, 7], [-20, 0, 0], a, 1500, 70, 0.8),
      ];
      const focal = 30;
      // Start exactly where the screen fills the frame like a "fill"-fit clip.
      const startY = screenY - fillDistance(screenW, screenH, focal, aspect);
      objs.push(cam([0, 0, 0], [90, 0, 0], focal, { camera: { focalLength: focal, dof: false, focusDistance: 8, fStop: 4 }, ...onPath([[0, startY, screenZ], [0, -12, 3.6]], 0, d - 1, "easeInOut") }));
      return finish(p, "stageReveal", objs, { world: { color: "#030305", strength: 0.2, fog: p.fog ?? 0.04, reflections: 0 } });
    },
  },
  {
    id: "metalTitle",
    label: "Metal Title (two-tone)",
    description: "Extruded title with a bright metal face and gold bevel edges in a red atmosphere with drifting embers; slow push-in.",
    build(p) {
      const d = p.durationFrames;
      const a = p.accentA ?? "#ff2a2a";
      const body = p.text ?? "TITLE";
      // Fit the longest line to ~80 % of the frame width at the end of the push-in.
      const size = fitTextSize(body, 1.3, 9, 50, p.aspect ?? 16 / 9);
      const text = makeSceneObject({
        kind: "text",
        name: "Title",
        rotation: [90, 0, 0],
        text: { body, size, extrude: 0.22, bevel: 0.045, align: "center", letterSpacing: 1, sideMaterial: mat({ preset: "gold", baseColor: "#ffc356", metallic: 1, roughness: 0.25 }) },
        material: mat({ baseColor: "#f4f4f6", metallic: 0.85, roughness: 0.18 }),
        animation: [{ property: "rotation", keyframes: [{ frame: 0, value: [90, 0, -6], easing: "easeOut" }, { frame: d - 1, value: [90, 0, 4], easing: "linear" }] }],
      });
      return finish(
        p,
        "metalTitle",
        [
          text,
          // Low and slightly off-axis so the gold bevel and sides read.
          cam([0, 0, 0], [89, 0, 0], 50, { camera: { focalLength: 50, dof: true, focusDistance: 10.5, fStop: 2.2, trackTargetId: text.id }, ...onPath([[-1.6, -12.5, -0.9], [1.1, -9, -0.6]], 0, d - 1, "easeOut") }),
          box("Smoke", [0, 9, 0], [60, 40, 1], { baseColor: "#000000", roughness: 1, emissionColor: a, emissionStrength: 0.9, pattern: "smoke", patternScale: 3 }, "plane", [90, 0, 0]),
          areaLight("Key", [-4, -6, 4], [55, 0, -35], "#fff4ea", 1400, 4),
          areaLight("Under gold", [0, -4, -3], [-60, 0, 0], "#ffd27a", 900, 5),
          areaLight("Red rim L", [-6, 2, 1], [80, 0, -110], a, 1600, 4),
          areaLight("Red rim R", [6, 2, 1], [80, 0, 110], a, 1600, 4),
          particles(a, 500, 9),
        ],
        { world: { color: "#140103", strength: 0.5, fog: p.fog ?? 0, reflections: 1.4 } },
      );
    },
  },
);

export const SCENE_TEMPLATE_IDS = SCENE_TEMPLATES.map((t) => t.id);

export function buildSceneFromTemplate(templateId: string, params: SceneTemplateParams): Scene {
  const t = SCENE_TEMPLATES.find((s) => s.id === templateId);
  if (!t) throw new Error(`Unknown scene template "${templateId}". Available: ${SCENE_TEMPLATE_IDS.join(", ")}`);
  return t.build(params);
}

// ---------------------------------------------------------------- render quality presets

export interface RenderPresetSpec {
  id: string;
  label: string;
  description: string;
  render: Partial<Scene["render"]>;
}

/** One-click render quality settings for 3D scenes (final renders; drafts are always fast). */
export const RENDER_PRESETS: RenderPresetSpec[] = [
  { id: "eeveeFast", label: "EEVEE fast", description: "Real-time engine, low samples. Seconds per frame.", render: { engine: "eevee", samples: 16, motionBlur: false, bloom: true } },
  { id: "eeveeHigh", label: "EEVEE high", description: "Real-time engine, high samples, motion blur. The default look.", render: { engine: "eevee", samples: 64, motionBlur: true, bloom: true } },
  { id: "cyclesPreview", label: "Cycles GPU preview", description: "Path traced on the GPU (OptiX/CUDA when available), 64 samples + denoise.", render: { engine: "cycles", samples: 64, denoise: true, motionBlur: false } },
  { id: "cyclesFinal", label: "Cycles GPU final", description: "Path traced, 256 samples + denoise + motion blur. Realistic chrome and glass.", render: { engine: "cycles", samples: 256, denoise: true, motionBlur: true } },
  { id: "cyclesFilm", label: "Cycles film", description: "1024 samples + denoise + motion blur. Slow; for hero shots.", render: { engine: "cycles", samples: 1024, denoise: true, motionBlur: true } },
];
export const RENDER_PRESET_IDS = RENDER_PRESETS.map((p) => p.id);

/** Id of the preset whose settings the render currently matches, if any. */
export function matchingRenderPreset(render: Scene["render"]): string | undefined {
  return RENDER_PRESETS.find((p) => Object.entries(p.render).every(([k, v]) => render[k as keyof Scene["render"]] === v))?.id;
}
