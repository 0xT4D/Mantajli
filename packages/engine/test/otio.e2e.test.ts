import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { FIXTURES, makeFixtures, TMP } from "./fixtures.js";

process.env.MANTAGLI_HOME = path.join(TMP, "home-otio");
const { Engine } = await import("../src/engine.js");
const { executeTool } = await import("../src/ai/tools.js");
const { importOtio } = await import("../src/interchange/otio.js");

type Json = Record<string, any>;

const engine = new Engine();
const outside: string[] = [];
afterAll(async () => {
  await engine.closeProject();
  for (const d of outside) await rm(d, { recursive: true, force: true });
});

const dir = path.join(TMP, "otio");

describe("OpenTimelineIO interchange", () => {
  it("exports a timeline as otio_json and imports it back losslessly", async () => {
    await engine.init();
    const media = await makeFixtures();
    // The fixtures folder is an allowed AI media folder (as if the user added it in Settings).
    await engine.config.update({ aiMediaFolders: [FIXTURES] });
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });

    // ---- source project
    await engine.createProject({ name: "OTIO Source", format: "landscape", parentDir: path.join(dir, "a") });
    const r = await engine.importMedia([media.video, media.video2, media.music]);
    const [vidA, vidB, music] = r.imported;
    const s = engine.requireSession();
    const track = (n: string) => s.project.tracks.find((t) => t.name === n)!.id;
    const a = s.dispatch("clip.add", { trackId: track("V1"), clip: { type: "media", assetId: vidA!.id, start: 0, duration: 30, sourceIn: 1.5, name: "Shot A" } });
    const b = s.dispatch("clip.add", { trackId: track("V1"), clip: { type: "media", assetId: vidB!.id, start: 30, duration: 24, speed: 2 } });
    s.dispatch("clip.setTransition", { clipId: b.clipId, transition: { type: "crossfade", duration: 8 } });
    s.dispatch("effect.add", { clipId: a.clipId, type: "vignette", params: { amount: 0.4 } });
    s.dispatch("keyframe.set", { clipId: a.clipId, property: "scale", keyframe: { frame: 0, value: 1 } });
    s.dispatch("keyframe.set", { clipId: a.clipId, property: "scale", keyframe: { frame: 29, value: 1.25 } });
    s.dispatch("clip.add", { trackId: track("Titles"), clip: { type: "text", text: "HELLO\nWORLD", start: 10, duration: 20 } });
    const scene = s.dispatch("scene.create", { name: "Logo", template: "chromeTitle", durationFrames: 24, text: "M" });
    const t3d = s.dispatch("track.add", { kind: "scene", name: "3D" });
    s.dispatch("clip.add", { trackId: t3d.trackId, clip: { type: "scene", sceneId: scene.sceneId, start: 40, duration: 24 } });
    s.dispatch("clip.add", { trackId: track("Music"), clip: { type: "media", assetId: music!.id, start: 0, duration: 90 } });
    s.dispatch("track.update", { trackId: track("Music"), volumeDb: -6 });
    s.dispatch("marker.add", { frame: 15, kind: "beat" });
    s.dispatch("marker.add", { frame: 30, kind: "cue", label: "Drop" });
    const srcProject = structuredClone(s.project);

    const ex = await executeTool({ engine, source: "ai" }, "timeline_export_otio", {});
    expect(ex.ok, JSON.stringify(ex.error)).toBe(true);
    const otioPath = (ex.data as { path: string }).path;
    expect(otioPath).toBe(path.join(s.dir, "exports", "OTIO Source.otio"));

    // ---- structure readable by other OTIO consumers
    const doc = JSON.parse(await readFile(otioPath, "utf8")) as Json;
    expect(doc.OTIO_SCHEMA).toBe("Timeline.1");
    expect(doc.tracks.OTIO_SCHEMA).toBe("Stack.1");
    const tracks = doc.tracks.children as Json[];
    expect(tracks.map((t) => t.kind)).toEqual(["Video", "Video", "Video", "Video", "Audio", "Audio"]);
    // Bottom layer first: V1 is the first OTIO track.
    const v1 = tracks[0]!;
    expect(v1.name).toBe("V1");
    expect(v1.children.map((c: Json) => c.OTIO_SCHEMA)).toEqual(["Clip.2", "Transition.1", "Clip.2"]);
    expect(v1.children[0].source_range.start_time.value).toBeCloseTo(1.5 * 30);
    expect(v1.children[0].media_references.DEFAULT_MEDIA.target_url).toBe(pathToFileURL(vidA!.path).href);
    expect(v1.children[1].transition_type).toBe("SMPTE_Dissolve");
    expect(v1.children[2].effects[0]).toMatchObject({ OTIO_SCHEMA: "LinearTimeWarp.1", time_scalar: 2 });
    const titles = tracks.find((t) => t.name === "Titles")!;
    expect(titles.children.map((c: Json) => c.OTIO_SCHEMA)).toEqual(["Gap.1", "Clip.2"]);
    expect(titles.children[0].source_range.duration.value).toBe(10);
    expect(doc.tracks.markers).toHaveLength(2);

    // ---- import into a fresh project
    await engine.closeProject();
    await engine.createProject({ name: "OTIO Target", format: "landscape", parentDir: path.join(dir, "b") });
    const t = engine.requireSession();
    const before = t.project.tracks.length;
    const imp = await importOtio(engine, otioPath);
    expect(imp.warnings).toEqual([]);
    expect(imp).toMatchObject({ tracks: 6, clips: 5, markers: 2, importedMedia: 3 });
    const p = t.project;
    expect(p.tracks.length).toBe(before + 6);

    // Same layer order and clip timing as the source (new tracks sit on top / bottom).
    const shape = (pr: typeof p, names: string[]) =>
      pr.tracks.filter((x) => names.includes(x.name)).map((x) => [x.kind, x.name, x.volumeDb, x.clips.map((c) => [c.type, c.start, c.duration, c.name, c.transitionIn?.type ?? null])]);
    const srcNames = srcProject.tracks.map((x) => x.name);
    const importedTracks = p.tracks.slice(0, 4).concat(p.tracks.slice(-2));
    expect(importedTracks.map((x) => x.name)).toEqual(srcNames);
    expect(shape({ ...p, tracks: importedTracks }, srcNames)).toEqual(shape(srcProject, srcNames));

    const clips = importedTracks.flatMap((x) => x.clips);
    const shotA = clips.find((c) => c.name === "Shot A")!;
    expect(shotA.type === "media" && shotA.sourceIn).toBeCloseTo(1.5);
    expect(shotA.effects.map((e) => e.type)).toEqual(["vignette"]);
    expect(shotA.keyframes.scale).toEqual(srcProject.tracks.find((x) => x.name === "V1")!.clips[0]!.keyframes.scale);
    const shotB = importedTracks.find((x) => x.name === "V1")!.clips[1]!;
    expect(shotB.type === "media" && shotB.speed).toBe(2);
    expect(shotB.transitionIn).toEqual({ type: "crossfade", duration: 8 });
    const text = clips.find((c) => c.type === "text")!;
    expect(text.type === "text" && text.text).toBe("HELLO\nWORLD");
    const sc = clips.find((c) => c.type === "scene")!;
    const newScene = p.scenes.find((x) => sc.type === "scene" && x.id === sc.sceneId)!;
    const srcScene = srcProject.scenes[0]!;
    expect(newScene.objects.map((o) => [o.kind, o.name])).toEqual(srcScene.objects.map((o) => [o.kind, o.name]));
    expect(newScene.objects.map((o) => o.animation.length)).toEqual(srcScene.objects.map((o) => o.animation.length));
    expect(p.markers.map((m) => [m.frame, m.kind, m.label])).toEqual([[15, "beat", ""], [30, "cue", "Drop"]]);

    // One undo step removes the imported timeline (media stays in the bin).
    t.undo();
    expect(t.project.tracks.length).toBe(before);
    expect(t.project.markers).toHaveLength(0);
    expect(t.project.assets).toHaveLength(3);
  });

  it("imports a third-party OTIO and keeps AI imports inside the media boundary", async () => {
    const media = await makeFixtures();
    // A folder outside every allowed AI media root.
    const ext = await mkdtemp(path.join(os.tmpdir(), "mantagli-otio-ext-"));
    outside.push(ext);
    const forbidden = path.join(ext, "secret.png");
    await copyFile(media.image, forbidden);
    const rt = (v: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate: 24, value: v });
    const range = (s: number, d: number) => ({ OTIO_SCHEMA: "TimeRange.1", start_time: rt(s), duration: rt(d) });
    const clip = (name: string, url: string, s: number, d: number) => ({
      OTIO_SCHEMA: "Clip.1",
      name,
      source_range: range(s, d),
      media_reference: { OTIO_SCHEMA: "ExternalReference.1", target_url: url },
      effects: [],
      markers: [],
      metadata: {},
    });
    const foreign = {
      OTIO_SCHEMA: "Timeline.1",
      name: "From Resolve",
      tracks: {
        OTIO_SCHEMA: "Stack.1",
        children: [
          {
            OTIO_SCHEMA: "Track.1",
            name: "Video 1",
            kind: "Video",
            markers: [{ OTIO_SCHEMA: "Marker.2", name: "Hit", marked_range: range(48, 0) }],
            children: [
              // Relative path → resolved next to the .otio file.
              clip("rel", "clip_a.mp4", 24, 48),
              { OTIO_SCHEMA: "Transition.1", transition_type: "SMPTE_Dissolve", in_offset: rt(6), out_offset: rt(6) },
              clip("outside", pathToFileURL(forbidden).href, 0, 24),
              { OTIO_SCHEMA: "Gap.1", source_range: range(0, 24) },
              clip("abs", pathToFileURL(media.video2).href, 0, 12),
            ],
          },
        ],
      },
    };
    const s = engine.requireSession();
    await copyFile(media.video, path.join(s.dir, "clip_a.mp4"));
    const file = path.join(s.dir, "foreign.otio");
    await writeFile(file, JSON.stringify(foreign));

    const res = await executeTool({ engine, source: "ai" }, "timeline_import_otio", { path: file });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const data = res.data as { clips: number; warnings: string[] };
    expect(data.clips).toBe(2);
    expect(data.warnings.some((w) => w.includes("secret.png") && w.includes("outside"))).toBe(true);
    expect(s.project.assets.some((a) => a.path === forbidden)).toBe(false);

    const tr = s.project.tracks.find((x) => x.name === "Video 1")!;
    const fps = 30; // landscape project
    // 48 frames at 24 fps = 2 s = 60 frames; outside clip skipped but its 1 s stays as a hole; 1 s gap.
    expect(tr.clips.map((c) => [c.start, c.duration])).toEqual([[0, 60], [60 + fps + fps, 15]]);
    const first = tr.clips[0]!;
    expect(first.type === "media" && first.sourceIn).toBeCloseTo(1);
    // The dissolve led into a skipped clip, so it is not applied to the next one.
    expect(tr.clips[1]!.transitionIn).toBeNull();
    expect(s.project.markers.map((m) => [m.frame, m.label])).toContainEqual([60, "Hit"]);

    const denied = await executeTool({ engine, source: "ai" }, "timeline_import_otio", { path: path.join(ext, "x.otio") });
    expect(denied.error?.category).toBe("permission_denied");
  });
});
