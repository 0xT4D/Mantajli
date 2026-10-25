import { AlertTriangle, Bot, Check, CircleDot, Clapperboard, FolderOpen, Loader2, Pause, Play, Redo2, Save, Settings, Undo2, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import { formatTimecode, FORMAT_PRESETS, type FormatPreset } from "@mantagli/core";
import { pickFiles, pickSavePath, revealInFolder } from "../lib/platform";
import { useStudio, type JobInfo, type Workspace } from "../store/studio";
import { Button, cx, Dialog, IconButton, NumberField, Progress, Row, Select, TextField, Toggle } from "./ui";

export function TopBar() {
  const { session, undo, redo, workspace, setWorkspace, playing, setPlaying, playhead, setDialog, call, aiPanelOpen, toggleAiPanel } = useStudio();
  const p = session.project;
  const save = session.saveState;
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
      <div className="flex items-center gap-2 pr-2">
        <Clapperboard size={16} className="text-accent" />
        <span className="text-[13px] font-semibold tracking-tight">Mantagli</span>
      </div>
      <div className="h-5 w-px bg-line" />
      <IconButton icon={<FolderOpen size={15} />} label="Open project" shortcut="Ctrl+O" onClick={() => setDialog("openProject")} />
      <IconButton icon={<Save size={15} />} label="Save now (also autosaves)" shortcut="Ctrl+S" disabled={!p} onClick={() => void call("project.save")} />
      {p && (
        <div className="flex min-w-0 items-center gap-1.5 px-1">
          <span className="max-w-56 truncate text-[12px] font-medium" title={session.dir}>
            {p.name}
          </span>
          <span className={cx("flex items-center gap-1 text-[10px]", save === "error" ? "text-err" : save === "saved" ? "text-mute" : "text-warn")} title={save === "error" ? "Save failed — see notifications" : undefined}>
            {save === "saving" ? <Loader2 size={10} className="animate-spin" /> : save === "saved" ? <Check size={10} /> : save === "error" ? <AlertTriangle size={10} /> : <CircleDot size={10} />}
            {save === "saved" ? "Saved" : save === "saving" ? "Saving" : save === "error" ? "Save failed" : "Unsaved"}
          </span>
        </div>
      )}
      <div className="h-5 w-px bg-line" />
      <IconButton icon={<Undo2 size={15} />} label="Undo" shortcut="Ctrl+Z" disabled={!session.canUndo} onClick={() => void undo()} />
      <IconButton icon={<Redo2 size={15} />} label="Redo" shortcut="Ctrl+Shift+Z" disabled={!session.canRedo} onClick={() => void redo()} />

      <div className="flex flex-1 justify-center">
        <div className="flex rounded border border-line bg-bg p-0.5">
          {(
            [
              ["edit", "Edit"],
              ["color", "Color"],
              ["3d", "3D"],
              ["ai", "AI Director"],
            ] as [Workspace, string][]
          ).map(([w, label]) => (
            <button key={w} type="button" onClick={() => setWorkspace(w)} className={cx("rounded px-3 py-1 text-[11px] font-medium", workspace === w ? "bg-raised text-fg" : "text-dim hover:text-fg")}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {p && (
        <>
          <IconButton icon={playing ? <Pause size={15} /> : <Play size={15} />} label={playing ? "Pause" : "Play"} shortcut="Space" onClick={() => setPlaying(!playing)} />
          <span className="tabular w-[84px] font-mono text-[11px] text-dim">{formatTimecode(playhead, p.settings.fps)}</span>
        </>
      )}
      <IconButton icon={<Bot size={15} />} label="AI Director panel" active={aiPanelOpen} onClick={() => toggleAiPanel()} />
      <Button variant="primary" disabled={!p} onClick={() => setDialog("export")}>
        <Upload size={13} /> Export
      </Button>
      <IconButton icon={<Settings size={15} />} label="Settings" onClick={() => setDialog("settings")} />
    </div>
  );
}

export function StatusBar() {
  const { jobs, info, call, connection } = useStudio();
  const active = Object.values(jobs).filter((j) => j.status === "running" || j.status === "queued");
  const [open, setOpen] = useState(false);
  const recent = Object.values(jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
  const deps = info?.deps;
  return (
    <div className="relative flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel px-2 text-[10px] text-mute">
      <span className={cx(connection === "connected" ? "text-ok" : "text-err")}>● engine {connection}</span>
      <span title={deps?.ffmpeg?.path}>{deps?.ffmpeg ? `FFmpeg ${deps.ffmpeg.version}` : <span className="text-err">FFmpeg missing</span>}</span>
      <span title={deps?.blender?.path}>{deps?.blender ? `Blender ${deps.blender.version}` : <span className="text-warn">Blender missing</span>}</span>
      {deps?.blender?.cyclesDevice && (
        <span className={deps.blender.cyclesDevice === "CPU" ? "text-warn" : undefined} title="Compute device used by the last Cycles render">
          Cycles {deps.blender.cyclesDevice === "CPU" ? "CPU (no GPU found)" : `GPU · ${deps.blender.cyclesDevice}`}
        </span>
      )}
      <div className="flex-1" />
      <button type="button" className="flex items-center gap-2 hover:text-fg" onClick={() => setOpen(!open)}>
        {active.length ? (
          <>
            <Loader2 size={11} className="animate-spin text-accent-2" />
            <span className="max-w-72 truncate">
              {active[0]!.label}
              {active[0]!.message ? ` — ${active[0]!.message}` : ""}
            </span>
            <Progress value={active[0]!.progress} className="w-24" />
            {active.length > 1 && <span>+{active.length - 1}</span>}
          </>
        ) : (
          <span>No background jobs</span>
        )}
      </button>
      {open && (
        <div className="absolute right-2 bottom-7 z-40 max-h-80 w-[420px] overflow-auto rounded border border-line-2 bg-raised p-1 shadow-2xl">
          {recent.length === 0 && <div className="p-2 text-[11px]">No jobs yet.</div>}
          {recent.map((j) => (
            <JobRow key={j.id} job={j} onCancel={() => void call("jobs.cancel", { jobId: j.id })} />
          ))}
        </div>
      )}
    </div>
  );
}

function JobRow({ job, onCancel }: { job: JobInfo; onCancel: () => void }) {
  const live = job.status === "running" || job.status === "queued";
  return (
    <div className="rounded px-2 py-1 hover:bg-hover">
      <div className="flex items-center gap-2 text-[11px]">
        <span className={cx("w-14 shrink-0", job.status === "done" ? "text-ok" : job.status === "failed" ? "text-err" : job.status === "cancelled" ? "text-mute" : "text-accent-2")}>{job.status}</span>
        <span className="min-w-0 flex-1 truncate text-fg">{job.label}</span>
        {live && <IconButton size={18} icon={<X size={11} />} label="Cancel job" onClick={onCancel} />}
        {job.status === "done" && job.outputs[0] && <button type="button" className="text-[10px] text-accent-2 hover:underline" onClick={() => void revealInFolder(job.outputs[0]!)}>show</button>}
      </div>
      {live && <Progress value={job.progress} className="mt-1" />}
      {job.error && <div className="mt-0.5 text-[10px] break-words text-err">{job.error.message}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ dialogs

export function NewProjectDialog() {
  const { setDialog, call, info } = useStudio();
  const [name, setName] = useState("My Montage");
  const [format, setFormat] = useState<FormatPreset>("vertical");
  const [fps, setFps] = useState("30");
  const [parent, setParent] = useState(info?.projectsDir ?? "");
  const create = async () => {
    const r = await call("project.create", { name, format, fps: { num: Number(fps), den: 1 }, parentDir: parent || undefined }).catch(() => null);
    if (r) setDialog(null);
  };
  return (
    <Dialog
      title="New project"
      onClose={() => setDialog(null)}
      footer={
        <>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void create()}>
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Row label="Name">
          <TextField value={name} onCommit={setName} />
        </Row>
        <Row label="Format">
          <Select value={format} onChange={setFormat} options={Object.entries(FORMAT_PRESETS).map(([k, v]) => ({ value: k as FormatPreset, label: v.label }))} />
        </Row>
        <Row label="Frame rate">
          <Select value={fps} onChange={setFps} options={["24", "25", "30", "50", "60"].map((f) => ({ value: f, label: `${f} fps` }))} />
        </Row>
        <Row label="Location">
          <TextField value={parent} onCommit={setParent} />
          <Button
            onClick={async () => {
              const r = await pickFiles({ directory: true, title: "Projects folder" });
              if (r?.[0]) setParent(r[0]);
            }}
          >
            Browse
          </Button>
        </Row>
        <div className="text-[10px] text-mute">A folder “{name}.mantagli” is created with the project file, backups and caches. Media stays where it is.</div>
      </div>
    </Dialog>
  );
}

export function OpenProjectDialog() {
  const { setDialog, info } = useStudio();
  const [path, setPath] = useState("");
  const open = async (p: string, force = false) => {
    try {
      await useStudio.getState().call("project.open", { path: p, force });
      setDialog(null);
    } catch (e) {
      if ((e as { category?: string }).category === "conflict" && /another Mantagli process/.test((e as Error).message) && window.confirm("The project looks open elsewhere (or a previous session crashed). Open anyway?")) await open(p, true);
    }
  };
  return (
    <Dialog title="Open project" onClose={() => setDialog(null)}>
      <div className="space-y-3">
        <div className="flex gap-1">
          <TextField value={path} onCommit={setPath} placeholder="Path to a .mantagli folder" />
          <Button
            onClick={async () => {
              const r = await pickFiles({ directory: true, title: "Open a .mantagli project folder" });
              if (r?.[0]) void open(r[0]);
            }}
          >
            Browse
          </Button>
          <Button variant="primary" disabled={!path} onClick={() => void open(path)}>
            Open
          </Button>
        </div>
        <div>
          <div className="mb-1 text-[11px] font-semibold text-dim">Recent</div>
          {(info?.settings.recentProjects ?? []).length === 0 && <div className="text-[11px] text-mute">No recent projects.</div>}
          {(info?.settings.recentProjects ?? []).map((r) => (
            <button key={r} type="button" onClick={() => void open(r)} className="block w-full truncate rounded px-2 py-1 text-left text-[11px] hover:bg-hover" title={r}>
              {r.split(/[\\/]/).pop()?.replace(/\.mantagli$/, "")} <span className="text-mute">— {r}</span>
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

interface ValidateResult {
  ok: boolean;
  issues: { severity: "error" | "warning"; message: string }[];
  estimate: { frames: number; seconds: number; sceneFrames: number };
}

export function ExportDialog() {
  const { setDialog, call, jobs, session } = useStudio();
  const p = session.project!;
  const aspect = p.settings.width / p.settings.height;
  const presets = [
    { value: "reel1080", label: "Reel / TikTok 1080×1920 H.264", a: 9 / 16 },
    { value: "reel4k", label: "Vertical 4K 2160×3840 H.264", a: 9 / 16 },
    { value: "square1080", label: "Square 1080×1080 H.264", a: 1 },
    { value: "landscape1080", label: "YouTube 1920×1080 H.264", a: 16 / 9 },
    { value: "landscape4k", label: "4K 3840×2160 H.264", a: 16 / 9 },
    { value: "reel720", label: "Reel 720×1280 H.264 (smaller, faster)", a: 9 / 16 },
    { value: "landscape720", label: "HD 1280×720 H.264 (smaller, faster)", a: 16 / 9 },
    { value: "project", label: `Project size ${p.settings.width}×${p.settings.height} H.264`, a: aspect },
    { value: "master", label: `Master ProRes 422 HQ (${p.settings.width}×${p.settings.height})`, a: aspect },
  ].filter((x) => Math.abs(x.a - aspect) < 0.01);
  const [preset, setPreset] = useState(presets.find((x) => x.value === p.export.preset)?.value ?? presets[0]?.value ?? "master");
  const [check, setCheck] = useState<ValidateResult | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [outPath, setOutPath] = useState<string>("");
  useEffect(() => {
    void call<ValidateResult>("render.validate", { preset }).then(setCheck).catch(() => {});
  }, [preset, p.modifiedAt, call]);
  const job = jobId ? jobs[jobId] : undefined;
  const start = async () => {
    if (check && check.estimate.seconds > 120 && !window.confirm(`This export is ${check.estimate.seconds.toFixed(0)} s long with ${check.estimate.sceneFrames} 3D frames to render at final quality. Continue?`)) return;
    const j = await call<JobInfo>("render.export", { preset, outPath: outPath || undefined }).catch(() => null);
    if (j) setJobId(j.id);
  };
  const ext = preset === "master" ? "mov" : "mp4";
  return (
    <Dialog
      title="Export"
      onClose={() => setDialog(null)}
      footer={
        job?.status === "running" || job?.status === "queued" ? (
          <Button variant="danger" onClick={() => void call("jobs.cancel", { jobId: job.id })}>
            Cancel export
          </Button>
        ) : (
          <>
            <Button onClick={() => setDialog(null)}>Close</Button>
            <Button variant="primary" disabled={!check?.ok} onClick={() => void start()}>
              <Upload size={13} /> {job?.status === "done" ? "Export again" : "Export"}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-2">
        <Row label="Preset">
          <Select value={preset} onChange={setPreset} options={presets.map((x) => ({ value: x.value, label: x.label }))} />
        </Row>
        <Row label="Output">
          <TextField value={outPath} onCommit={setOutPath} placeholder={`Default: ${session.dir}\\exports\\…${ext}`} />
          <Button
            onClick={async () => {
              const r = await pickSavePath({ defaultPath: `${p.name}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
              if (r) setOutPath(r);
            }}
          >
            Browse
          </Button>
        </Row>
        {check && (
          <div className="rounded border border-line bg-panel-2 p-2 text-[11px]">
            <div className="text-dim">
              {check.estimate.seconds.toFixed(2)} s · {check.estimate.frames} frames{check.estimate.sceneFrames ? ` · ${check.estimate.sceneFrames} Blender frames at final quality` : ""}
            </div>
            {check.issues.map((i, n) => (
              <div key={n} className={i.severity === "error" ? "text-err" : "text-warn"}>
                {i.severity === "error" ? "✕" : "!"} {i.message}
              </div>
            ))}
            {check.ok && !check.issues.length && <div className="text-ok">Ready to export.</div>}
          </div>
        )}
        {job && (
          <div className="rounded border border-line p-2 text-[11px]">
            <div className="mb-1 flex justify-between">
              <span>{job.message ?? job.status}</span>
              <span className="tabular">{job.progress !== null ? `${Math.round(job.progress * 100)}%` : ""}</span>
            </div>
            <Progress value={job.status === "done" ? 1 : job.progress} />
            {job.status === "done" && (
              <div className="mt-2 space-y-1 text-ok">
                <div>Export verified (FFprobe + sample decode).</div>
                <button type="button" className="text-accent-2 hover:underline" onClick={() => void revealInFolder(job.outputs[0]!)}>
                  {job.outputs[0]}
                </button>
              </div>
            )}
            {job.status === "failed" && <div className="mt-1 text-err">{job.error?.message}</div>}
            {job.status === "cancelled" && <div className="mt-1 text-mute">Cancelled. Already rendered 3D frames are kept and reused next time.</div>}
          </div>
        )}
        <OtioSection />
        <CaptionsSection />
      </div>
    </Dialog>
  );
}

const OTIO_FILTERS = [{ name: "OpenTimelineIO", extensions: ["otio"] }];
const SUB_FILTERS = [{ name: "Subtitles", extensions: ["srt", "vtt"] }];

/** Subtitles in (styled caption clips) and out (.srt from a text track). */
function CaptionsSection() {
  const { call, toast, session } = useStudio();
  const p = session.project!;
  const [style, setStyle] = useState<string>("bold");
  const [position, setPosition] = useState<string>("bottom");
  const textTracks = p.tracks.filter((t) => t.kind === "text" && t.clips.some((c) => c.type === "text"));
  const [trackId, setTrackId] = useState<string>("");
  const exportTrack = textTracks.find((t) => t.id === trackId) ?? textTracks.find((t) => t.name === "Captions") ?? textTracks[0];
  const importSubs = async () => {
    const picked = await pickFiles({ filters: SUB_FILTERS, title: "Import subtitles" });
    const file = picked === null ? window.prompt("Path of the .srt or .vtt file") : picked[0];
    if (!file) return;
    const r = await call<{ clips: number; skipped: number }>("interchange.importCaptions", { path: file, style, position }).catch(() => null);
    if (r) toast("ok", `Imported ${r.clips} captions${r.skipped ? ` (${r.skipped} skipped)` : ""}`);
  };
  const exportSubs = async () => {
    if (!exportTrack) return;
    const r = await pickSavePath({ defaultPath: `${p.name}.srt`, filters: [{ name: "SubRip", extensions: ["srt"] }] });
    if (r === null) return;
    const out = await call<{ path: string; cues: number }>("interchange.exportCaptions", { trackId: exportTrack.id, ...(r ? { path: r } : {}) }).catch(() => null);
    if (out) toast("ok", `Wrote ${out.cues} cues to ${out.path}`);
  };
  return (
    <div className="space-y-1.5 border-t border-line pt-2">
      <div className="text-[11px] font-semibold text-dim">Captions (.srt / .vtt)</div>
      <Row label="Style">
        <Select value={style} onChange={setStyle} options={[{ value: "bold", label: "Bold (stroked, pop)" }, { value: "boxed", label: "Boxed" }, { value: "clean", label: "Clean" }, { value: "karaoke", label: "Karaoke yellow" }, { value: "kinetic", label: "Kinetic (word by word)" }]} />
        <Select value={position} onChange={setPosition} options={[{ value: "bottom", label: "Bottom" }, { value: "middle", label: "Middle" }, { value: "top", label: "Top" }]} />
      </Row>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void importSubs()}>Import subtitles</Button>
        {exportTrack && (
          <>
            <Select value={exportTrack.id} onChange={setTrackId} options={textTracks.map((t) => ({ value: t.id, label: t.name }))} />
            <Button onClick={() => void exportSubs()}>Export .srt</Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Timeline interchange with other editors (OpenTimelineIO JSON). */
function OtioSection() {
  const { call, toast, session } = useStudio();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // call() already reported the error
    } finally {
      setBusy(false);
    }
  };
  const exportOtio = () =>
    run(async () => {
      const r = await pickSavePath({ defaultPath: `${session.project!.name}.otio`, filters: OTIO_FILTERS });
      if (r === null) return; // dialog cancelled; undefined = browser dev mode → default path
      const out = await call<{ path: string; clips: number }>("interchange.exportOtio", r ? { path: r } : {});
      setLast(out.path);
      toast("ok", `Timeline exported to OTIO (${out.clips} clips)`);
    });
  const importOtio = () =>
    run(async () => {
      const picked = await pickFiles({ filters: OTIO_FILTERS, title: "Import an OpenTimelineIO timeline" });
      const file = picked === null ? window.prompt("Path of the .otio file to import") : picked[0];
      if (!file) return;
      const r = await call<{ tracks: number; clips: number; markers: number; warnings: string[] }>("interchange.importOtio", { path: file });
      toast(r.warnings.length ? "info" : "ok", `Imported ${r.clips} clips on ${r.tracks} tracks${r.markers ? `, ${r.markers} markers` : ""}${r.warnings.length ? ` · ${r.warnings.length} warning(s): ${r.warnings[0]}` : ""}`);
    });
  return (
    <div className="space-y-1.5 border-t border-line pt-2">
      <div className="text-[11px] font-semibold text-dim">Timeline interchange (OpenTimelineIO)</div>
      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => void exportOtio()}>
          Export .otio
        </Button>
        <Button disabled={busy} onClick={() => void importOtio()}>
          Import .otio as new tracks
        </Button>
      </div>
      {last && (
        <button type="button" className="text-[11px] text-accent-2 hover:underline" onClick={() => void revealInFolder(last)}>
          {last}
        </button>
      )}
    </div>
  );
}

export function SettingsDialog() {
  const { setDialog, info, call, updateSettings } = useStudio();
  const s = info?.settings;
  const [blender, setBlender] = useState(s?.blenderPath ?? "");
  const [ffmpeg, setFfmpeg] = useState(s?.ffmpegPath ?? "");
  if (!info || !s) return null;
  return (
    <Dialog title="Settings" onClose={() => setDialog(null)} width={600}>
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="text-[11px] font-semibold text-dim">Dependencies</div>
          {info.deps.problems.map((p) => (
            <div key={p} className="rounded border border-warn/40 bg-warn/10 p-1.5 text-[11px] text-warn">
              {p}
            </div>
          ))}
          <Row label="Blender">
            <TextField value={blender} onCommit={setBlender} placeholder={info.deps.blender?.path ?? "auto-detect"} />
            <Button onClick={() => void updateSettings({ blenderPath: blender || undefined }).then(() => call("app.refreshDeps"))}>Apply</Button>
          </Row>
          <div className="pl-24 text-[10px] text-mute">{info.deps.blender ? `Blender ${info.deps.blender.version} · engines: ${info.deps.blender.engines.join(", ")} · importers: ${info.deps.blender.importers.join(", ")}` : "Not found"}</div>
          <Row label="FFmpeg">
            <TextField value={ffmpeg} onCommit={setFfmpeg} placeholder={info.deps.ffmpeg?.path ?? "auto-detect"} />
            <Button onClick={() => void updateSettings({ ffmpegPath: ffmpeg || undefined }).then(() => call("app.refreshDeps"))}>Apply</Button>
          </Row>
        </div>
        <div className="space-y-2">
          <div className="text-[11px] font-semibold text-dim">Preview</div>
          <Row label="Preview scale">
            <NumberField value={s.previewScale} min={0.1} max={1} step={0.05} onChange={(v) => void updateSettings({ previewScale: v })} />
          </Row>
          <Row label="3D previews" title="Re-render draft frames of 3D scenes on the timeline in the background after edits">
            <Toggle checked={s.autoRenderScenes} onChange={(v) => void updateSettings({ autoRenderScenes: v })} label="Auto-render after edits" />
          </Row>
        </div>
        <div className="space-y-2">
          <div className="text-[11px] font-semibold text-dim">AI Director</div>
          <Row label="Model">
            <TextField value={s.aiModel} onCommit={(v) => v && void updateSettings({ aiModel: v })} />
          </Row>
          <Row label="Mode">
            <Select value={s.aiAutonomy} onChange={(v) => void updateSettings({ aiAutonomy: v })} options={[{ value: "review", label: "Review — ask before exports and large deletions" }, { value: "autonomous", label: "Autonomous — apply without asking" }]} />
          </Row>
          <Row label="Media folders" title="Besides your Videos, Music, Pictures, Downloads, Desktop and Documents folders and the project folder, the AI may import from and export to these folders. Separate folders with ;">
            <TextField
              value={s.aiMediaFolders.join("; ")}
              placeholder="e.g. D:\Footage; D:\Music"
              onCommit={(v) => void updateSettings({ aiMediaFolders: v.split(";").map((d) => d.trim()).filter(Boolean) })}
            />
          </Row>
          <div className="text-[10px] text-mute">API key: {info.ai.hasKey ? "configured" : "not set"} (set it in the AI panel). Claude Code can also drive Mantagli through the MCP server — see README.</div>
        </div>
      </div>
    </Dialog>
  );
}

export function Welcome() {
  const { setDialog, info, call } = useStudio();
  return (
    <div className="flex h-full items-center justify-center bg-bg">
      <div className="w-[520px] space-y-5">
        <div className="flex items-center gap-3">
          <Clapperboard size={34} className="text-accent" />
          <div>
            <div className="text-[22px] font-semibold tracking-tight">Mantagli</div>
            <div className="text-[12px] text-dim">AI-directed 3D montage studio</div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => setDialog("newProject")}>
            New project
          </Button>
          <Button onClick={() => setDialog("openProject")}>
            <FolderOpen size={13} /> Open…
          </Button>
        </div>
        {(info?.settings.recentProjects.length ?? 0) > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-semibold text-dim">Recent projects</div>
            {info!.settings.recentProjects.slice(0, 8).map((r) => (
              <button key={r} type="button" onClick={() => void call("project.open", { path: r }).catch(() => {})} className="block w-full truncate rounded px-2 py-1.5 text-left text-[12px] hover:bg-hover" title={r}>
                {r.split(/[\\/]/).pop()?.replace(/\.mantagli$/, "")}
                <span className="ml-2 text-[10px] text-mute">{r}</span>
              </button>
            ))}
          </div>
        )}
        {info && info.deps.problems.length > 0 && (
          <div className="space-y-1">
            {info.deps.problems.map((p) => (
              <div key={p} className="rounded border border-warn/40 bg-warn/10 p-2 text-[11px] text-warn">
                {p}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useStudio();
  return (
    <div className="pointer-events-none fixed right-3 bottom-8 z-[60] flex w-80 flex-col gap-1.5">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            "pointer-events-auto flex items-start gap-2 rounded border px-2.5 py-2 text-[11px] shadow-xl",
            t.kind === "error" ? "border-err/50 bg-[#2a1416] text-[#ffb4b8]" : t.kind === "ok" ? "border-ok/40 bg-[#122219] text-[#a8e8c4]" : "border-line-2 bg-raised text-fg",
          )}
        >
          <span className="min-w-0 flex-1 break-words">{t.text}</span>
          <button type="button" onClick={() => dismissToast(t.id)} className="opacity-60 hover:opacity-100">
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
