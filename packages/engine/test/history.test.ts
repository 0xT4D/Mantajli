import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HISTORY_FILE } from "../src/historyStore.js";
import { ProjectSession } from "../src/session.js";

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const v1 = (s: ProjectSession) => s.project.tracks.find((t) => t.name === "V1")!.id;
const clipCount = (s: ProjectSession) => s.project.tracks.reduce((n, t) => n + t.clips.length, 0);

describe("persistent undo history", () => {
  it("survives closing and reopening the project", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "mantagli-hist-"));
    let s = await ProjectSession.create(dir, { name: "Hist", format: "landscape" });
    const pdir = s.dir;
    for (let i = 0; i < 40; i++) s.dispatch("clip.add", { trackId: v1(s), clip: { type: "color", fill: "#112233", start: i * 10, duration: 10 } }, "user", `Add ${i}`);
    s.dispatch("project.rename", { name: "Renamed" }, "ai", "Rename");
    s.undo(); // leaves one redo step
    await s.close();

    // Snapshots share structure on disk: 41 snapshots of a 40-clip project stay small.
    const histSize = (await stat(path.join(pdir, HISTORY_FILE))).size;
    const projSize = (await stat(path.join(pdir, "project.json"))).size;
    expect(histSize).toBeLessThan(projSize * 12);

    s = await ProjectSession.open(pdir);
    expect(s.project.name).toBe("Hist");
    expect(s.history.list().undo[0]).toMatchObject({ label: "Add 39", source: "user" });
    expect(s.history.list().redo[0]).toMatchObject({ label: "Rename", source: "ai" });
    s.redo();
    expect(s.project.name).toBe("Renamed");
    s.undo();
    for (let i = 0; i < 40; i++) s.undo();
    expect(clipCount(s)).toBe(0);
    expect(s.history.canUndo()).toBe(false); // back at the freshly created project
    s.redo();
    expect(clipCount(s)).toBe(1);
    // Edits after reopening keep working with the restored (frozen) snapshots.
    s.dispatch("clip.add", { trackId: v1(s), clip: { type: "color", fill: "#ffffff", start: 500, duration: 5 } });
    expect(clipCount(s)).toBe(2);
    s.undo();
    expect(clipCount(s)).toBe(1);
    await s.close();
  });

  it("drops history that does not belong to the project file", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "mantagli-hist-"));
    let s = await ProjectSession.create(dir, { name: "Stale", format: "landscape" });
    const pdir = s.dir;
    s.dispatch("clip.add", { trackId: v1(s), clip: { type: "color", fill: "#112233", start: 0, duration: 10 } });
    await s.close();
    // Someone edits project.json outside Mantagli.
    const file = path.join(pdir, "project.json");
    const p = JSON.parse(await readFile(file, "utf8"));
    p.name = "Edited elsewhere";
    await writeFile(file, JSON.stringify(p, null, 1));
    s = await ProjectSession.open(pdir);
    expect(s.project.name).toBe("Edited elsewhere");
    expect(s.history.canUndo()).toBe(false);
    await s.close();
  });
});
