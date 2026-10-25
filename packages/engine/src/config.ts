import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { exists, readJson, writeFileAtomic } from "./util/fsx.js";
import { run } from "./util/proc.js";

export function appDataDir(): string {
  if (process.env.MANTAGLI_HOME) return process.env.MANTAGLI_HOME;
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Mantagli");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Mantagli");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "mantagli");
}

export const AppSettingsSchema = z.object({
  blenderPath: z.string().optional(),
  ffmpegPath: z.string().optional(),
  ffprobePath: z.string().optional(),
  projectsDir: z.string().optional(),
  recentProjects: z.array(z.string()).default([]),
  aiModel: z.string().default("claude-opus-5-5"),
  /** review: AI proposes and the user approves large edits; autonomous: AI applies directly. */
  aiAutonomy: z.enum(["review", "autonomous"]).default("review"),
  /** Extra folders (absolute) the AI/MCP may import media from and export to, besides the user media folders. */
  aiMediaFolders: z.array(z.string()).default([]),
  previewScale: z.number().min(0.1).max(1).default(0.5),
  /** Re-render draft frames of timeline 3D scenes in the background after edits. */
  autoRenderScenes: z.boolean().default(true),
  /** Opaque UI preferences (layout sizes, last workspace...). */
  ui: z.record(z.string(), z.unknown()).default({}),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export class AppConfig {
  settings: AppSettings = AppSettingsSchema.parse({});
  readonly file = path.join(appDataDir(), "settings.json");

  async load(): Promise<void> {
    if (await exists(this.file)) {
      try {
        this.settings = AppSettingsSchema.parse(await readJson(this.file));
      } catch {
        // Corrupt settings are not fatal; keep defaults and overwrite on next save.
      }
    }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = AppSettingsSchema.parse({ ...this.settings, ...patch });
    await writeFileAtomic(this.file, JSON.stringify(this.settings, null, 2));
    return this.settings;
  }

  async addRecent(projectDir: string): Promise<void> {
    const list = [projectDir, ...this.settings.recentProjects.filter((p) => p !== projectDir)].slice(0, 15);
    await this.update({ recentProjects: list });
  }

  get projectsDir(): string {
    return this.settings.projectsDir ?? path.join(os.homedir(), "Documents", "Mantagli Projects");
  }
}

// ---------------------------------------------------------------- dependency discovery

const exe = (n: string) => (process.platform === "win32" ? `${n}.exe` : n);

export async function findOnPath(name: string): Promise<string | undefined> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, exe(name));
    if (await exists(p)) return p;
  }
  return undefined;
}

async function blenderCandidates(): Promise<string[]> {
  const out: string[] = [];
  if (process.platform === "win32") {
    const roots = [
      "C:\\Program Files\\Blender Foundation",
      "D:\\DevTools",
      "D:\\Program Files\\Blender Foundation",
      path.join(process.env.LOCALAPPDATA ?? "", "Programs"),
    ];
    for (const root of roots) {
      try {
        const entries = await readdir(root);
        for (const e of entries.filter((e) => /blender/i.test(e)).sort().reverse()) out.push(path.join(root, e, "blender.exe"));
      } catch {
        /* missing root */
      }
    }
    // Steam install
    out.push("C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe");
  } else if (process.platform === "darwin") {
    out.push("/Applications/Blender.app/Contents/MacOS/Blender");
  } else {
    out.push("/usr/bin/blender", "/snap/bin/blender", "/usr/local/bin/blender");
  }
  return out;
}

export interface DependencyStatus {
  ffmpeg?: { path: string; version: string };
  ffprobe?: { path: string };
  /** cyclesDevice: compute backend the last Cycles render used (OPTIX, CUDA, HIP, METAL, ONEAPI or CPU). */
  blender?: { path: string; version: string; engines: string[]; importers: string[]; cyclesDevice?: string };
  problems: string[];
}

export async function discoverDependencies(settings: AppSettings): Promise<DependencyStatus> {
  const problems: string[] = [];
  const status: DependencyStatus = { problems };

  const ffmpeg = process.env.MANTAGLI_FFMPEG ?? settings.ffmpegPath ?? (await findOnPath("ffmpeg"));
  const ffprobe = process.env.MANTAGLI_FFPROBE ?? settings.ffprobePath ?? (ffmpeg ? path.join(path.dirname(ffmpeg), exe("ffprobe")) : await findOnPath("ffprobe"));
  if (ffmpeg && (await exists(ffmpeg))) {
    try {
      const r = await run(ffmpeg, ["-hide_banner", "-version"], { timeoutMs: 15000 });
      status.ffmpeg = { path: ffmpeg, version: r.stdout.split("\n")[0]?.replace(/^ffmpeg version\s*/, "").split(" ")[0] ?? "unknown" };
    } catch (e) {
      problems.push(`FFmpeg found at ${ffmpeg} but failed to run: ${(e as Error).message}`);
    }
  } else problems.push("FFmpeg not found. Install it (e.g. `winget install Gyan.FFmpeg`) or set its path in Settings.");
  if (ffprobe && (await exists(ffprobe))) status.ffprobe = { path: ffprobe };
  else problems.push("FFprobe not found (it ships with FFmpeg).");

  let blender = process.env.MANTAGLI_BLENDER ?? settings.blenderPath ?? (await findOnPath("blender"));
  if (!blender || !(await exists(blender))) {
    blender = undefined;
    for (const c of await blenderCandidates()) if (await exists(c)) { blender = c; break; }
  }
  if (blender) {
    try {
      const probe = [
        "import bpy, json, addon_utils",
        "addon_utils.enable('cycles', default_set=False)",
        "engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]",
        "imp = [n for n, ok in [('gltf', hasattr(bpy.ops.import_scene, 'gltf')), ('obj', hasattr(bpy.ops.wm, 'obj_import')), ('fbx', hasattr(bpy.ops.import_scene, 'fbx')), ('stl', hasattr(bpy.ops.wm, 'stl_import'))] if ok]",
        "print('MANTAGLI_PROBE ' + json.dumps({'version': bpy.app.version_string, 'engines': engines, 'importers': imp}))",
      ].join("\n");
      const r = await run(blender, ["-b", "--factory-startup", "--python-exit-code", "1", "--python-expr", probe], { timeoutMs: 120000 });
      const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("MANTAGLI_PROBE "));
      if (!line) throw new Error(r.stderr.slice(-500) || "no probe output");
      const info = JSON.parse(line.slice("MANTAGLI_PROBE ".length)) as { version: string; engines: string[]; importers: string[] };
      status.blender = { path: blender, ...info };
    } catch (e) {
      problems.push(`Blender found at ${blender} but failed its capability check: ${(e as Error).message}`);
    }
  } else {
    problems.push("Blender not found. Install Blender 4.2+ or set its path in Settings; 3D scenes cannot render without it.");
  }
  return status;
}
