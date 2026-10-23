import { AlertTriangle, AudioLines, Box, Download, FileType, Film, Grid2x2, Image as ImageIcon, LayoutList, Link2, Palette, Plus, Search, Shapes, Star, Trash2, Waves } from "lucide-react";
import { useMemo, useState } from "react";
import { formatDuration, LOOKS, SCENE_TEMPLATES, type Asset, type AssetKind } from "@mantagli/core";
import { engine } from "../engine/client";
import { isTauri, MEDIA_FILTERS, pickFiles } from "../lib/platform";
import { projectFile, useStudio } from "../store/studio";
import { DRAG_ASSET, DRAG_SCENE } from "./Timeline";
import { Button, ColorField, cx, Empty, IconButton, NumberField, Progress, Row, Select, TextField } from "./ui";

const KIND_ICON: Record<AssetKind, React.ReactNode> = {
  video: <Film size={13} />,
  audio: <AudioLines size={13} />,
  image: <ImageIcon size={13} />,
  model: <Shapes size={13} />,
  font: <FileType size={13} />,
  lut: <Palette size={13} />,
};

function fmtSize(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export function MediaBrowser({ initialTab = "media" }: { initialTab?: "media" | "scenes" | "looks" }) {
  const [tab, setTab] = useState<"media" | "scenes" | "looks">(initialTab);
  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-8 shrink-0 items-end gap-0.5 border-b border-line px-1">
        {(
          [
            ["media", "Media"],
            ["scenes", "3D Scenes"],
            ["looks", "Looks"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cx("h-7 rounded-t px-2.5 text-[11px] font-medium", tab === id ? "border-x border-t border-line bg-panel-2 text-fg" : "text-dim hover:text-fg")}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{tab === "media" ? <MediaTab /> : tab === "scenes" ? <ScenesTab /> : <LooksTab />}</div>
    </div>
  );
}

export async function importFlow(): Promise<void> {
  const { call, toast } = useStudio.getState();
  const paths = await pickFiles({ multiple: true, filters: MEDIA_FILTERS, title: "Import media" });
  if (paths === null) {
    const raw = window.prompt("Browser dev mode has no file dialog.\nPaste one or more absolute file paths (one per line or separated by ;):");
    if (!raw) return;
    return importPaths(raw.split(/[\n;]+/).map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean));
  }
  if (paths.length) await importPaths(paths);
  void call;
  void toast;
}

export async function importPaths(paths: string[]): Promise<void> {
  const { call, toast } = useStudio.getState();
  const r = await call<{ imported: Asset[]; duplicates: unknown[]; errors: { path: string; message: string }[] }>("media.import", { paths }).catch(() => null);
  if (!r) return;
  if (r.imported.length) toast("ok", `Imported ${r.imported.length} file${r.imported.length > 1 ? "s" : ""}`);
  if (r.duplicates.length) toast("info", `${r.duplicates.length} duplicate${r.duplicates.length > 1 ? "s" : ""} skipped (already in the project)`);
  for (const e of r.errors.slice(0, 3)) toast("error", `${e.path.split(/[\\/]/).pop()}: ${e.message}`);
}

function MediaTab() {
  const project = useStudio((s) => s.session.project)!;
  const { selection, setSelection, jobs } = useStudio();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | AssetKind | "favorites">("all");
  const [view, setView] = useState<"grid" | "list">("grid");
  const assets = useMemo(
    () =>
      project.assets.filter(
        (a) =>
          (kind === "all" || (kind === "favorites" ? a.favorite : a.kind === kind)) &&
          (!q || a.name.toLowerCase().includes(q.toLowerCase()) || a.tags.some((t) => t.toLowerCase().includes(q.toLowerCase()))),
      ),
    [project.assets, q, kind],
  );
  const activeJobs = Object.values(jobs).filter((j) => (j.status === "running" || j.status === "queued") && ["proxy", "thumbnail", "waveform", "filmstrip", "beats"].includes(j.type));
  const selectedAsset = selection.kind === "asset" ? project.assets.find((a) => a.id === selection.id) : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 p-2">
        <Button variant="primary" onClick={() => void importFlow()} title="Import video, audio, images, 3D models, fonts and LUTs (Ctrl+I)">
          <Download size={13} /> Import
        </Button>
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded border border-line bg-bg px-1.5">
          <Search size={12} className="text-mute" />
          <input className="min-w-0 flex-1 bg-transparent text-[11px] outline-none" placeholder="Search name or tag" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        <IconButton icon={view === "grid" ? <LayoutList size={14} /> : <Grid2x2 size={14} />} label={view === "grid" ? "List view" : "Grid view"} onClick={() => setView(view === "grid" ? "list" : "grid")} />
      </div>
      <div className="flex shrink-0 flex-wrap gap-1 px-2 pb-2">
        {(["all", "video", "audio", "image", "model", "font", "lut", "favorites"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} className={cx("rounded px-1.5 py-0.5 text-[10px] capitalize", kind === k ? "bg-accent/20 text-accent-2" : "bg-raised text-dim hover:text-fg")}>
            {k === "favorites" ? "★" : k}
          </button>
        ))}
      </div>
      {activeJobs.length > 0 && (
        <div className="mx-2 mb-2 rounded border border-line bg-panel-2 px-2 py-1.5">
          <div className="mb-1 text-[10px] text-dim">Processing {activeJobs.length} task(s): {activeJobs[0]!.label}</div>
          <Progress value={activeJobs[0]!.progress} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {project.assets.length === 0 ? (
          <Empty icon={<Download size={28} />} title="No media yet" hint={isTauri ? "Import files or drop them anywhere on the window." : "Import files by path (browser dev mode)."} action={<Button onClick={() => void importFlow()}>Import media</Button>} />
        ) : assets.length === 0 ? (
          <Empty title="Nothing matches" />
        ) : view === "grid" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2">
            {assets.map((a) => (
              <AssetCard key={a.id} asset={a} selected={selectedAsset?.id === a.id} onSelect={() => setSelection({ kind: "asset", id: a.id })} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col">
            {assets.map((a) => (
              <AssetRow key={a.id} asset={a} selected={selectedAsset?.id === a.id} onSelect={() => setSelection({ kind: "asset", id: a.id })} />
            ))}
          </div>
        )}
      </div>
      {selectedAsset && <AssetActions asset={selectedAsset} />}
    </div>
  );
}

function dragProps(a: Asset) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(DRAG_ASSET, a.id);
      e.dataTransfer.effectAllowed = "copy";
    },
  };
}

function meta(a: Asset): string {
  const parts: string[] = [];
  if (a.meta.duration !== undefined) parts.push(formatDuration(a.meta.duration));
  if (a.meta.width) parts.push(`${a.meta.width}×${a.meta.height}`);
  if (a.meta.fps) parts.push(`${(a.meta.fps.num / a.meta.fps.den).toFixed(2).replace(/\.00$/, "")}fps`);
  if (a.kind === "audio" && a.meta.sampleRate) parts.push(`${(a.meta.sampleRate / 1000).toFixed(1)}kHz`);
  return parts.join(" · ");
}

function AssetCard({ asset: a, selected, onSelect }: { asset: Asset; selected: boolean; onSelect: () => void }) {
  const thumb = a.derived.thumbnail ? engine.fileUrl(projectFile(a.derived.thumbnail)) : undefined;
  return (
    <div {...dragProps(a)} onClick={onSelect} className={cx("group cursor-pointer overflow-hidden rounded border bg-panel-2", selected ? "border-accent" : "border-line hover:border-line-2")} title={`${a.name}\n${a.path}`}>
      <div className="relative aspect-video bg-bg">
        {thumb ? (
          <img src={thumb} alt="" className="h-full w-full object-cover" draggable={false} loading="lazy" />
        ) : (
          <div className="flex h-full items-center justify-center text-mute">{a.kind === "audio" ? <Waves size={22} /> : KIND_ICON[a.kind]}</div>
        )}
        <span className="absolute top-1 left-1 rounded bg-black/60 p-0.5 text-white/80">{KIND_ICON[a.kind]}</span>
        {a.favorite && <Star size={11} className="absolute top-1.5 right-1.5 fill-warn text-warn" />}
        {a.status !== "ok" && (
          <span className="absolute inset-0 flex items-center justify-center gap-1 bg-black/70 text-[10px] font-semibold text-err">
            <AlertTriangle size={12} /> MISSING
          </span>
        )}
        {a.meta.duration !== undefined && <span className="tabular absolute right-1 bottom-1 rounded bg-black/70 px-1 font-mono text-[9px]">{formatDuration(a.meta.duration)}</span>}
        {a.analysis.beats && <span className="absolute bottom-1 left-1 rounded bg-warn/80 px-1 text-[9px] font-semibold text-black">{Math.round(a.analysis.beats.bpm)} BPM</span>}
      </div>
      <div className="truncate px-1.5 py-1 text-[11px]">{a.name}</div>
    </div>
  );
}

function AssetRow({ asset: a, selected, onSelect }: { asset: Asset; selected: boolean; onSelect: () => void }) {
  return (
    <div {...dragProps(a)} onClick={onSelect} className={cx("flex h-7 cursor-pointer items-center gap-2 rounded px-1.5", selected ? "bg-accent/15" : "hover:bg-hover")} title={a.path}>
      <span className="text-mute">{KIND_ICON[a.kind]}</span>
      <span className={cx("min-w-0 flex-1 truncate text-[11px]", a.status !== "ok" && "text-err")}>{a.name}</span>
      <span className="tabular shrink-0 text-[10px] text-mute">{meta(a)}</span>
      <span className="w-14 shrink-0 text-right text-[10px] text-mute">{fmtSize(a.size)}</span>
    </div>
  );
}

function AssetActions({ asset: a }: { asset: Asset }) {
  const { call, dispatch, playhead, toast, setSelection } = useStudio();
  const project = useStudio((s) => s.session.project)!;
  const used = project.tracks.some((t) => t.clips.some((c) => c.type === "media" && c.assetId === a.id));
  const relink = async () => {
    const p = await pickFiles({ title: `Locate ${a.name}` });
    const path = p === null ? window.prompt(`New path for ${a.name}:`) : p[0];
    if (path) await call("media.relink", { assetId: a.id, path }).then(() => toast("ok", "Relinked")).catch(() => {});
  };
  const addAtPlayhead = async () => {
    const wantAudio = a.kind === "audio";
    const track = project.tracks.find((t) => (t.kind === "audio") === wantAudio && !t.locked && (wantAudio || t.kind === "video"));
    if (!track) return toast("error", "No unlocked track of the right kind");
    await dispatch("clip.add", { trackId: track.id, clip: { type: "media", assetId: a.id, start: playhead } }, `Add ${a.name}`).catch(() => {});
  };
  return (
    <div className="shrink-0 space-y-1.5 border-t border-line bg-panel-2 p-2">
      <div className="truncate text-[11px] font-medium" title={a.path}>
        {a.name}
      </div>
      <div className="tabular text-[10px] text-mute">
        {[meta(a), fmtSize(a.size), a.meta.videoCodec, a.meta.audioCodec, a.meta.variableFrameRate ? "VFR" : ""].filter(Boolean).join(" · ")}
      </div>
      <div className="flex flex-wrap gap-1">
        {a.status !== "ok" && (
          <Button variant="danger" onClick={() => void relink()}>
            <Link2 size={12} /> Relink
          </Button>
        )}
        {["video", "audio", "image"].includes(a.kind) && a.status === "ok" && (
          <Button onClick={() => void addAtPlayhead()}>
            <Plus size={12} /> At playhead
          </Button>
        )}
        {a.meta.hasAudio && a.status === "ok" && (
          <Button onClick={() => void call("media.analyzeBeats", { assetId: a.id }).then((r) => toast("ok", `Detected ${(r as { analysis: { bpm: number } }).analysis.bpm} BPM — beat markers placed`)).catch(() => {})} title="Detect tempo, beats and transients; place beat markers on the timeline">
            <Waves size={12} /> Beats
          </Button>
        )}
        <IconButton icon={<Star size={13} className={a.favorite ? "fill-warn text-warn" : ""} />} label={a.favorite ? "Unfavourite" : "Favourite"} onClick={() => void dispatch("asset.update", { assetId: a.id, patch: { favorite: !a.favorite } }, "Favourite")} />
        <IconButton
          icon={<Trash2 size={13} />}
          label="Remove from project (the file on disk is not touched)"
          onClick={() => {
            if (used && !window.confirm(`${a.name} is used on the timeline. Remove it and its clips?`)) return;
            void dispatch("asset.remove", { assetId: a.id, force: used }, `Remove ${a.name}`).then(() => setSelection({ kind: "none" }));
          }}
        />
      </div>
      <TextField value={a.tags.join(", ")} placeholder="tags, comma separated" onCommit={(v) => void dispatch("asset.update", { assetId: a.id, patch: { tags: v.split(",").map((t) => t.trim()).filter(Boolean) } }, "Tags")} />
    </div>
  );
}

function ScenesTab() {
  const project = useStudio((s) => s.session.project)!;
  const { dispatch, selection, setSelection } = useStudio();
  const fps = project.settings.fps.num / project.settings.fps.den;
  const [template, setTemplate] = useState("chromeTitle");
  const [name, setName] = useState("Title");
  const [text, setText] = useState("MANTAGLI");
  const [seconds, setSeconds] = useState(3);
  const [accentA, setA] = useState("#8a2be2");
  const [accentB, setB] = useState("#00e5ff");
  const models = project.assets.filter((a) => a.kind === "model");
  const [model, setModel] = useState<string>("");
  const create = async () => {
    const r = (await dispatch(
      "scene.create",
      {
        name,
        template,
        durationFrames: Math.max(1, Math.round(seconds * fps)),
        text,
        accentA,
        accentB,
        ...(template === "productTurntable" && model ? { modelAssetId: model } : {}),
      },
      `New 3D scene ${name}`,
    ).catch(() => null)) as { sceneId: string } | null;
    if (r) setSelection({ kind: "scene", id: r.sceneId });
  };
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {project.scenes.length === 0 ? (
          <Empty icon={<Box size={26} />} title="No 3D scenes" hint="Create one below, then drag it onto a track. Scenes render with Blender." />
        ) : (
          project.scenes.map((s) => (
            <div
              key={s.id}
              draggable
              onDragStart={(e) => e.dataTransfer.setData(DRAG_SCENE, s.id)}
              onClick={() => setSelection({ kind: "scene", id: s.id })}
              className={cx("mb-1 flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5", selection.kind === "scene" && selection.id === s.id ? "border-accent bg-accent/10" : "border-line bg-panel-2 hover:border-line-2")}
            >
              <Box size={14} className="text-clip-scene" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-medium">{s.name}</div>
                <div className="text-[10px] text-mute">
                  {s.template ?? "custom"} · {(s.durationFrames / fps).toFixed(1)}s · {s.objects.length} objects · {s.render.engine}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="shrink-0 space-y-1.5 border-t border-line bg-panel-2 p-2">
        <div className="text-[11px] font-semibold text-dim">New 3D scene</div>
        <Row label="Template">
          <Select value={template} onChange={setTemplate} options={SCENE_TEMPLATES.map((t) => ({ value: t.id, label: t.label }))} />
        </Row>
        <div className="text-[10px] text-mute">{SCENE_TEMPLATES.find((t) => t.id === template)?.description}</div>
        <Row label="Name">
          <TextField value={name} onCommit={setName} />
        </Row>
        {template === "chromeTitle" && (
          <Row label="Title text">
            <TextField value={text} onCommit={setText} />
          </Row>
        )}
        {template === "productTurntable" && (
          <Row label="Model">
            <Select value={model} onChange={setModel} options={[{ value: "", label: "Rounded cube (no model)" }, ...models.map((m) => ({ value: m.id, label: m.name }))]} />
          </Row>
        )}
        <Row label="Duration">
          <NumberField value={seconds} onChange={setSeconds} min={0.2} max={600} step={0.1} unit="s" />
        </Row>
        <Row label="Accents">
          <ColorField value={accentA} onChange={setA} />
          <ColorField value={accentB} onChange={setB} />
        </Row>
        <Button variant="primary" onClick={() => void create()} className="w-full justify-center">
          <Plus size={13} /> Create scene
        </Button>
      </div>
    </div>
  );
}

function LooksTab() {
  const { selection, transaction, toast } = useStudio();
  const project = useStudio((s) => s.session.project)!;
  const clipIds = selection.kind === "clips" ? selection.ids : [];
  const apply = async (lookId: string) => {
    const look = LOOKS.find((l) => l.id === lookId)!;
    const visual = clipIds.filter((id) => project.tracks.some((t) => t.kind !== "audio" && t.clips.some((c) => c.id === id)));
    if (!visual.length) return toast("info", "Select one or more visual clips on the timeline first");
    const cmds = visual.flatMap((clipId) => {
      const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
      return [
        ...clip.effects.map((e) => ({ name: "effect.remove" as const, params: { clipId, effectId: e.id } })),
        ...look.effects.map((e) => ({ name: "effect.add" as const, params: { clipId, type: e.type, params: e.params } })),
      ];
    });
    await transaction(`Look: ${look.label}`, cmds).catch(() => {});
  };
  return (
    <div className="h-full overflow-auto p-2">
      <div className="mb-2 text-[10px] text-mute">{clipIds.length ? `Applies to ${clipIds.length} selected clip(s), replacing their effects.` : "Select clips on the timeline, then pick a look."}</div>
      {LOOKS.map((l) => (
        <button key={l.id} type="button" onClick={() => void apply(l.id)} className="mb-1 block w-full rounded border border-line bg-panel-2 px-2 py-1.5 text-left hover:border-accent">
          <div className="text-[11px] font-medium">{l.label}</div>
          <div className="text-[10px] text-mute">{l.description}</div>
          <div className="mt-0.5 text-[9px] text-dim">{l.effects.map((e) => e.type).join(" · ")}</div>
        </button>
      ))}
    </div>
  );
}
