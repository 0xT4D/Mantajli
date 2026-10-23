import { makeSceneObject } from "./factories.js";
import { newId } from "./ids.js";
import { MATERIAL_PRESETS, SceneSchema, type Scene, type SceneObject } from "./schema.js";

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
  extra: Partial<SceneObject> = {},
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

export const SCENE_TEMPLATES: SceneTemplateSpec[] = [
  {
    id: "chromeTitle",
    label: "3D Chrome Title",
    description: "Extruded chrome typography floating in darkness with a slow camera push-in, coloured rim lights, studio reflections and glowing particles.",
    build(p) {
      const a = p.accentA ?? "#8a2be2";
      const b = p.accentB ?? "#00e5ff";
      const d = p.durationFrames;
      const text = makeSceneObject({
        kind: "text",
        name: "Title",
        location: [0, 0, 0],
        rotation: [90, 0, 0],
        text: { body: p.text ?? "TITLE", size: 1.4, extrude: 0.18, bevel: 0.03, align: "center", letterSpacing: 1.05 },
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
        ? makeSceneObject({ kind: "model", name: "Product", model: { assetId: p.modelAssetId } })
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

export const SCENE_TEMPLATE_IDS = SCENE_TEMPLATES.map((t) => t.id);

export function buildSceneFromTemplate(templateId: string, params: SceneTemplateParams): Scene {
  const t = SCENE_TEMPLATES.find((s) => s.id === templateId);
  if (!t) throw new Error(`Unknown scene template "${templateId}". Available: ${SCENE_TEMPLATE_IDS.join(", ")}`);
  return t.build(params);
}
