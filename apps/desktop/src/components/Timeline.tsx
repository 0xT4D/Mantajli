import {
  AudioLines,
  Box,
  Diamond,
  Eye,
  EyeOff,
  Film,
  Lock,
  Magnet,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  Type,
  Unlock,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clipEnd, formatTimecode, fpsValue, projectDuration, TRANSITIONS, type Asset, type Clip, type Project, type Track } from "@mantagli/core";
import { engine } from "../engine/client";
import { projectFile, useStudio } from "../store/studio";
import { cx, IconButton } from "./ui";

const HEADER_W = 168;
const RULER_H = 26;
const TRACK_H: Record<Track["kind"], number> = { video: 58, scene: 50, text: 36, audio: 50 };
const CLIP_COLORS: Record<string, string> = { media: "var(--color-clip-video)", text: "var(--color-clip-text)", scene: "var(--color-clip-scene)", color: "var(--color-clip-color)", audio: "var(--color-clip-audio)" };

export const DRAG_ASSET = "application/x-mantagli-asset";
export const DRAG_SCENE = "application/x-mantagli-scene";

const waveformCache = new Map<string, Promise<{ peaksPerSecond: number; peaks: number[] } | null>>();
function loadWaveform(assetId: string, rel?: string) {
  const key = `${assetId}:${rel}`;
  if (!waveformCache.has(key)) waveformCache.set(key, rel ? engine.call<{ peaksPerSecond: number; peaks: number[] } | null>("media.waveform", { assetId }).catch(() => null) : Promise.resolve(null));
  return waveformCache.get(key)!;
}

type DragState =
  | { kind: "move"; clipIds: string[]; anchorId: string; startX: number; startY: number; origStart: number; origTrack: string; deltaFrames: number; targetTrack: string; moved: boolean }
  | { kind: "trim"; clipId: string; edge: "start" | "end"; startX: number; frame: number; orig: number }
  | { kind: "scrub" };

function niceStep(pxPerFrame: number, fps: number): { major: number; minor: number } {
  const candidates = [1, 2, 5, 10, Math.round(fps / 2), Math.round(fps), Math.round(fps * 2), Math.round(fps * 5), Math.round(fps * 10), Math.round(fps * 30), Math.round(fps * 60), Math.round(fps * 300)];
  const major = candidates.find((c) => c * pxPerFrame >= 70) ?? candidates[candidates.length - 1]!;
  const minor = candidates.find((c) => c * pxPerFrame >= 12 && major % c === 0) ?? major;
  return { major, minor };
}

export function Timeline() {
  const project = useStudio((s) => s.session.project);
  if (!project) return null;
  return <TimelineInner project={project} />;
}

function TimelineInner({ project }: { project: Project }) {
  const { zoom, setZoom, playhead, setPlayhead, selection, setSelection, snapping, set, dispatch, transaction, call } = useStudio();
  const fps = fpsValue(project.settings.fps);
  const duration = projectDuration(project);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; clipId: string } | null>(null);
  const [dropHint, setDropHint] = useState<{ trackId: string; frame: number } | null>(null);
  const selectedClips = selection.kind === "clips" ? selection.ids : [];

  const contentW = Math.max((duration + fps * 20) * zoom, 2000);
  const trackTops = useMemo(() => {
    const tops: Record<string, number> = {};
    let y = 0;
    for (const t of project.tracks) {
      tops[t.id] = y;
      y += TRACK_H[t.kind];
    }
    return { tops, total: y };
  }, [project.tracks]);

  // Fit zoom once per project.
  const fittedFor = useRef<string>("");
  useLayoutEffect(() => {
    if (fittedFor.current === project.id || !scrollRef.current) return;
    fittedFor.current = project.id;
    const w = scrollRef.current.clientWidth - 40;
    setZoom(Math.max(0.2, Math.min(12, w / Math.max(duration, fps * 15))));
  }, [project.id, duration, fps, setZoom]);

  const frameAtX = useCallback((clientX: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.round((clientX - rect.left + el.scrollLeft) / zoom));
  }, [zoom]);

  const trackAtY = useCallback((clientY: number): Track | undefined => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    const y = clientY - rect.top + el.scrollTop - RULER_H;
    return project.tracks.find((t) => y >= trackTops.tops[t.id]! && y < trackTops.tops[t.id]! + TRACK_H[t.kind]);
  }, [project.tracks, trackTops]);

  const snapPoints = useMemo(() => {
    const pts = new Set<number>([0, playhead]);
    for (const t of project.tracks) for (const c of t.clips) if (!selectedClips.includes(c.id)) { pts.add(c.start); pts.add(clipEnd(c)); }
    for (const m of project.markers) pts.add(m.frame);
    return [...pts];
  }, [project, playhead, selectedClips]);

  const snap = useCallback((frame: number, exclude?: number[]) => {
    if (!snapping) return frame;
    const thr = 8 / zoom;
    let best = frame;
    let bestD = thr;
    for (const p of snapPoints) {
      if (exclude?.includes(p)) continue;
      const d = Math.abs(p - frame);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }, [snapPoints, snapping, zoom]);

  // ----- pointer handling
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      if (drag.kind === "scrub") {
        setPlayhead(frameAtX(e.clientX));
        return;
      }
      if (drag.kind === "move") {
        const dxFrames = Math.round((e.clientX - drag.startX) / zoom);
        const anchor = findClipIn(project, drag.anchorId)!;
        const snappedStart = snap(Math.max(0, drag.origStart + dxFrames));
        const snappedEnd = snap(drag.origStart + dxFrames + anchor.clip.duration);
        let delta = snappedStart - drag.origStart;
        if (snappedEnd !== drag.origStart + dxFrames + anchor.clip.duration && snappedStart === Math.max(0, drag.origStart + dxFrames)) delta = snappedEnd - anchor.clip.duration - drag.origStart;
        const t = trackAtY(e.clientY);
        setDrag({ ...drag, deltaFrames: delta, targetTrack: t && drag.clipIds.length === 1 && t.kind !== "audio" === (anchor.track.kind !== "audio") ? t.id : drag.origTrack, moved: drag.moved || Math.abs(e.clientX - drag.startX) > 3 || Math.abs(e.clientY - drag.startY) > 3 });
      }
      if (drag.kind === "trim") {
        const f = snap(Math.max(0, drag.orig + Math.round((e.clientX - drag.startX) / zoom)), [drag.orig]);
        setDrag({ ...drag, frame: f });
      }
    };
    const up = async () => {
      const d = drag;
      setDrag(null);
      if (d.kind === "move" && d.moved && (d.deltaFrames !== 0 || d.targetTrack !== d.origTrack)) {
        const cmds = d.clipIds.map((id) => {
          const ref = findClipIn(project, id)!;
          return { name: "clip.move" as const, params: { clipId: id, start: Math.max(0, ref.clip.start + d.deltaFrames), ...(d.clipIds.length === 1 && d.targetTrack !== d.origTrack ? { trackId: d.targetTrack } : {}) } };
        });
        await transaction(cmds.length > 1 ? `Move ${cmds.length} clips` : "Move clip", cmds).catch(() => {});
      }
      if (d.kind === "trim" && d.frame !== d.orig) await dispatch("clip.trim", { clipId: d.clipId, edge: d.edge, frame: d.frame }, `Trim ${d.edge}`).catch(() => {});
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, zoom, project, frameAtX, trackAtY, snap, setPlayhead, dispatch, transaction]);

  // Keep the playhead visible during playback.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const x = playhead * zoom;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - 80);
  }, [playhead, zoom]);

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const el = scrollRef.current!;
      const frame = frameAtX(e.clientX);
      const next = Math.min(40, Math.max(0.05, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      setZoom(next);
      requestAnimationFrame(() => {
        el.scrollLeft = frame * next - (e.clientX - el.getBoundingClientRect().left);
      });
    }
  };

  // ----- drop from media browser
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_ASSET) && !e.dataTransfer.types.includes(DRAG_SCENE)) return;
    e.preventDefault();
    const t = trackAtY(e.clientY);
    if (t) setDropHint({ trackId: t.id, frame: snap(frameAtX(e.clientX)) });
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropHint(null);
    const frame = snap(frameAtX(e.clientX));
    let track = trackAtY(e.clientY);
    const assetId = e.dataTransfer.getData(DRAG_ASSET);
    const sceneId = e.dataTransfer.getData(DRAG_SCENE);
    if (assetId) {
      const asset = project.assets.find((a) => a.id === assetId);
      if (!asset) return;
      if (!["video", "audio", "image"].includes(asset.kind)) {
        useStudio.getState().toast("info", `${asset.kind} assets are used inside 3D scenes or effects, not directly on the timeline`);
        return;
      }
      const wantAudio = asset.kind === "audio";
      if (!track || (track.kind === "audio") !== wantAudio) track = project.tracks.find((t) => (t.kind === "audio") === wantAudio && !t.locked);
      if (!track) return;
      await dispatch("clip.add", { trackId: track.id, clip: { type: "media", assetId, start: frame } }, `Add ${asset.name}`).catch(() => {});
    } else if (sceneId) {
      if (!track || track.kind === "audio") track = project.tracks.find((t) => t.kind !== "audio" && !t.locked);
      if (!track) return;
      await dispatch("clip.add", { trackId: track.id, clip: { type: "scene", sceneId, start: frame } }, "Add 3D scene").catch(() => {});
    }
  };

  const { major, minor } = niceStep(zoom, fps);
  const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
  const viewW = scrollRef.current?.clientWidth ?? 2000;
  const ticks: number[] = [];
  const first = Math.floor(scrollLeft / zoom / minor) * minor;
  for (let f = first; f * zoom < scrollLeft + viewW + 100; f += minor) ticks.push(f);
  const [, force] = useState(0);

  const addTrack = (kind: Track["kind"]) => void dispatch("track.add", { kind }, `Add ${kind} track`).catch(() => {});

  return (
    <div className="flex h-full flex-col bg-panel">
      {/* toolbar */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-dim">Timeline</span>
        <span className="tabular ml-2 font-mono text-[11px] text-accent-2">{formatTimecode(playhead, project.settings.fps)}</span>
        <span className="tabular font-mono text-[11px] text-mute">/ {formatTimecode(duration, project.settings.fps)}</span>
        <div className="flex-1" />
        <IconButton icon={<Scissors size={14} />} label="Split at playhead" shortcut="S" onClick={() => splitAtPlayhead()} />
        <IconButton icon={<Trash2 size={14} />} label="Delete selected" shortcut="Del" disabled={!selectedClips.length} onClick={() => void dispatch("clip.remove", { clipIds: selectedClips }, "Delete clips").then(() => setSelection({ kind: "none" }))} />
        <IconButton icon={<Magnet size={14} />} label={`Snapping ${snapping ? "on" : "off"}`} shortcut="N" active={snapping} onClick={() => set({ snapping: !snapping })} />
        <div className="mx-1 h-4 w-px bg-line" />
        <IconButton icon={<ZoomOut size={14} />} label="Zoom out" shortcut="-" onClick={() => setZoom(zoom / 1.4)} />
        <input type="range" className="w-24" min={-3} max={3.6} step={0.01} value={Math.log(zoom)} onChange={(e) => setZoom(Math.exp(Number(e.target.value)))} title="Timeline zoom" />
        <IconButton icon={<ZoomIn size={14} />} label="Zoom in" shortcut="+" onClick={() => setZoom(zoom * 1.4)} />
        <div className="mx-1 h-4 w-px bg-line" />
        <AddTrackMenu onAdd={addTrack} />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* track headers */}
        <div className="shrink-0 overflow-hidden border-r border-line" style={{ width: HEADER_W }}>
          <div style={{ height: RULER_H }} className="border-b border-line" />
          <div style={{ transform: `translateY(${-(scrollRef.current?.scrollTop ?? 0)}px)` }}>
            {project.tracks.map((t) => (
              <TrackHeader key={t.id} track={t} selected={selection.kind === "track" && selection.id === t.id} />
            ))}
          </div>
        </div>

        {/* lanes */}
        <div
          ref={scrollRef}
          className="relative min-w-0 flex-1 overflow-auto"
          onWheel={onWheel}
          onScroll={() => force((n) => n + 1)}
          onDragOver={onDragOver}
          onDragLeave={() => setDropHint(null)}
          onDrop={onDrop}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.lane) setSelection({ kind: "none" });
          }}
        >
          <div style={{ width: contentW, height: RULER_H + trackTops.total + 40 }} className="relative">
            {/* ruler */}
            <div
              className="sticky top-0 z-20 border-b border-line bg-panel-2"
              style={{ height: RULER_H }}
              onPointerDown={(e) => {
                setPlayhead(frameAtX(e.clientX));
                setDrag({ kind: "scrub" });
              }}
            >
              {ticks.map((f) => (
                <div key={f} className="absolute top-0" style={{ left: f * zoom }}>
                  <div className={cx("w-px bg-line-2", f % major === 0 ? "h-2.5" : "h-1.5")} />
                  {f % major === 0 && <div className="tabular absolute top-2.5 left-1 font-mono text-[9px] whitespace-nowrap text-mute">{formatTimecode(f, project.settings.fps).slice(3)}</div>}
                </div>
              ))}
              {project.markers.map((m) => (
                <div
                  key={m.id}
                  title={`${m.kind}${m.label ? `: ${m.label}` : ""} @ ${m.frame}`}
                  className="absolute bottom-0 cursor-pointer"
                  style={{ left: m.frame * zoom - 3 }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setPlayhead(m.frame);
                    setSelection({ kind: "marker", id: m.id });
                  }}
                >
                  <div
                    className={cx(
                      "h-0 w-0 border-x-[3px] border-b-[6px] border-x-transparent",
                      m.kind === "downbeat" ? "border-b-warn" : m.kind === "beat" ? "border-b-warn/50" : m.kind === "onset" ? "border-b-err/60" : "border-b-accent-2",
                    )}
                  />
                </div>
              ))}
            </div>

            {/* track lanes */}
            {project.tracks.map((t) => (
              <div key={t.id} data-lane="1" className={cx("absolute right-0 left-0 border-b border-line/70", t.hidden && "opacity-40")} style={{ top: RULER_H + trackTops.tops[t.id]!, height: TRACK_H[t.kind] }}>
                {dropHint?.trackId === t.id && <div className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-accent" style={{ left: dropHint.frame * zoom }} />}
                {t.clips.map((c) => (
                  <ClipView
                    key={c.id}
                    clip={c}
                    track={t}
                    project={project}
                    zoom={zoom}
                    selected={selectedClips.includes(c.id)}
                    drag={drag}
                    onPointerDown={(e, part) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
                      const ids = additive ? (selectedClips.includes(c.id) ? selectedClips.filter((x) => x !== c.id) : [...selectedClips, c.id]) : selectedClips.includes(c.id) ? selectedClips : [c.id];
                      setSelection({ kind: "clips", ids });
                      if (t.locked) return;
                      if (part === "body") setDrag({ kind: "move", clipIds: ids, anchorId: c.id, startX: e.clientX, startY: e.clientY, origStart: c.start, origTrack: t.id, deltaFrames: 0, targetTrack: t.id, moved: false });
                      else setDrag({ kind: "trim", clipId: c.id, edge: part, startX: e.clientX, orig: part === "start" ? c.start : clipEnd(c), frame: part === "start" ? c.start : clipEnd(c) });
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!selectedClips.includes(c.id)) setSelection({ kind: "clips", ids: [c.id] });
                      setMenu({ x: e.clientX, y: e.clientY, clipId: c.id });
                    }}
                  />
                ))}
              </div>
            ))}

            {/* playhead */}
            <div className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-accent" style={{ left: playhead * zoom }}>
              <div className="absolute -top-0 -left-[5px] h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-accent" />
            </div>
          </div>
        </div>
      </div>
      {menu && <ClipMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );

  function splitAtPlayhead() {
    const ids = selectedClips.length ? selectedClips : project.tracks.flatMap((t) => t.clips.filter((c) => c.start < playhead && clipEnd(c) > playhead).map((c) => c.id));
    const targets = ids.filter((id) => {
      const r = findClipIn(project, id);
      return r && r.clip.start < playhead && clipEnd(r.clip) > playhead && !r.track.locked;
    });
    if (!targets.length) return;
    void transaction("Split", targets.map((id) => ({ name: "clip.split" as const, params: { clipId: id, frame: playhead } })));
  }
  void call;
}

function findClipIn(p: Project, id: string): { clip: Clip; track: Track } | undefined {
  for (const track of p.tracks) {
    const clip = track.clips.find((c) => c.id === id);
    if (clip) return { clip, track };
  }
  return undefined;
}

function AddTrackMenu({ onAdd }: { onAdd: (k: Track["kind"]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <IconButton icon={<Plus size={14} />} label="Add track" onClick={() => setOpen(!open)} />
      {open && (
        <div className="absolute right-0 bottom-8 z-40 w-36 rounded border border-line-2 bg-raised py-1 shadow-xl" onMouseLeave={() => setOpen(false)}>
          {(
            [
              ["video", "Video track", <Film size={13} key="v" />],
              ["text", "Text track", <Type size={13} key="t" />],
              ["scene", "3D track", <Box size={13} key="s" />],
              ["audio", "Audio track", <AudioLines size={13} key="a" />],
            ] as const
          ).map(([k, label, icon]) => (
            <button
              key={k}
              type="button"
              className="flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] hover:bg-hover"
              onClick={() => {
                onAdd(k);
                setOpen(false);
              }}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TrackHeader({ track, selected }: { track: Track; selected: boolean }) {
  const { dispatch, setSelection } = useStudio();
  const upd = (patch: Record<string, unknown>, label: string) => void dispatch("track.update", { trackId: track.id, ...patch }, label).catch(() => {});
  const icon = track.kind === "audio" ? <AudioLines size={13} /> : track.kind === "text" ? <Type size={13} /> : track.kind === "scene" ? <Box size={13} /> : <Film size={13} />;
  return (
    <div
      className={cx("flex items-center gap-1 border-b border-line/70 px-2", selected && "bg-raised")}
      style={{ height: TRACK_H[track.kind] }}
      onClick={() => setSelection({ kind: "track", id: track.id })}
    >
      <span className="text-mute">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium" title={track.name}>
        {track.name}
        {track.role === "music" && <span className="ml-1 text-[9px] text-mute">♪</span>}
      </span>
      <IconButton size={20} icon={track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />} label={track.muted ? "Unmute" : "Mute"} active={track.muted} onClick={(e) => (e.stopPropagation(), upd({ muted: !track.muted }, "Mute"))} />
      <IconButton size={20} icon={<span className="text-[10px] font-bold">S</span>} label="Solo" active={track.solo} onClick={(e) => (e.stopPropagation(), upd({ solo: !track.solo }, "Solo"))} />
      {track.kind !== "audio" && <IconButton size={20} icon={track.hidden ? <EyeOff size={12} /> : <Eye size={12} />} label={track.hidden ? "Show" : "Hide"} active={track.hidden} onClick={(e) => (e.stopPropagation(), upd({ hidden: !track.hidden }, "Visibility"))} />}
      <IconButton size={20} icon={track.locked ? <Lock size={12} /> : <Unlock size={12} />} label={track.locked ? "Unlock" : "Lock"} active={track.locked} onClick={(e) => (e.stopPropagation(), upd({ locked: !track.locked }, "Lock"))} />
    </div>
  );
}

function ClipView({
  clip,
  track,
  project,
  zoom,
  selected,
  drag,
  onPointerDown,
  onContextMenu,
}: {
  clip: Clip;
  track: Track;
  project: Project;
  zoom: number;
  selected: boolean;
  drag: DragState | null;
  onPointerDown: (e: React.PointerEvent, part: "body" | "start" | "end") => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const fps = fpsValue(project.settings.fps);
  let start = clip.start;
  let dur = clip.duration;
  let ghostTrackOffset = 0;
  if (drag?.kind === "move" && drag.clipIds.includes(clip.id) && drag.moved) {
    start = Math.max(0, clip.start + drag.deltaFrames);
    if (drag.targetTrack !== track.id) {
      const tracks = project.tracks;
      const from = tracks.findIndex((t) => t.id === track.id);
      const to = tracks.findIndex((t) => t.id === drag.targetTrack);
      let off = 0;
      for (let i = Math.min(from, to); i < Math.max(from, to); i++) off += TRACK_H[tracks[i]!.kind];
      ghostTrackOffset = to > from ? off : -off;
    }
  }
  if (drag?.kind === "trim" && drag.clipId === clip.id) {
    if (drag.edge === "start") {
      start = Math.min(drag.frame, clipEnd(clip) - 1);
      dur = clipEnd(clip) - start;
    } else dur = Math.max(1, drag.frame - clip.start);
  }
  const asset = clip.type === "media" ? project.assets.find((a) => a.id === clip.assetId) : undefined;
  const missing = asset && asset.status !== "ok";
  const color = clip.type === "media" && (track.kind === "audio" || asset?.kind === "audio") ? CLIP_COLORS.audio : CLIP_COLORS[clip.type];
  const w = Math.max(2, dur * zoom);
  const label = clip.type === "text" ? clip.text : clip.name || (asset?.name ?? clip.type);
  const kfFrames = [...new Set(Object.values(clip.keyframes).flatMap((l) => (l ?? []).map((k) => k.frame)))];
  const filmstrip = asset?.derived.filmstrip ? engine.fileUrl(projectFile(asset.derived.filmstrip)) : asset?.kind === "image" && asset.derived.thumbnail ? engine.fileUrl(projectFile(asset.derived.thumbnail)) : undefined;
  let bg: React.CSSProperties = {};
  if (filmstrip && asset && clip.type === "media") {
    if (asset.kind === "image") bg = { backgroundImage: `url("${filmstrip}")`, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x" };
    else {
      const fullW = ((asset.meta.duration ?? 1) * fps * zoom) / clip.speed;
      bg = { backgroundImage: `url("${filmstrip}")`, backgroundSize: `${fullW}px 100%`, backgroundPositionX: `${(-clip.sourceIn * fps * zoom) / clip.speed}px`, backgroundRepeat: "no-repeat" };
    }
  }
  return (
    <div
      className={cx(
        "group absolute top-[3px] bottom-[3px] overflow-hidden rounded-[3px] border text-[10px]",
        selected ? "border-white/90 ring-1 ring-accent" : "border-black/40",
        drag?.kind === "move" && drag.clipIds.includes(clip.id) && drag.moved && "opacity-80 shadow-lg",
        track.locked && "cursor-not-allowed",
        missing && "border-err",
      )}
      style={{ left: start * zoom, width: w, background: color, transform: ghostTrackOffset ? `translateY(${ghostTrackOffset}px)` : undefined, zIndex: selected ? 5 : 1 }}
      onPointerDown={(e) => onPointerDown(e, "body")}
      onContextMenu={onContextMenu}
      title={`${label}\n${formatTimecode(clip.start, project.settings.fps)} → ${formatTimecode(clipEnd(clip), project.settings.fps)} (${dur}f)`}
    >
      {clip.type === "media" && (track.kind === "audio" || asset?.kind === "audio" || (asset?.meta.hasAudio && track.kind === "video" && clip.audioEnabled)) && asset && (
        <Waveform asset={asset} clip={clip} zoom={zoom} fps={fps} width={w} compact={track.kind !== "audio"} />
      )}
      {bg.backgroundImage && <div className="absolute inset-0 opacity-55" style={bg} />}
      {clip.type === "color" && <div className="absolute inset-1 rounded-sm" style={{ background: clip.fill, opacity: 0.6 }} />}
      <div className="relative flex h-4 items-center gap-1 bg-black/35 px-1 text-white/90">
        {clip.type === "scene" && <Box size={10} />}
        {clip.type === "text" && <Type size={10} />}
        <span className="truncate">{label}</span>
        {clip.type === "media" && clip.speed !== 1 && <span className="rounded bg-black/40 px-0.5 text-[9px]">{clip.speed}×</span>}
        {clip.effects.length > 0 && <Sparkles size={9} className="shrink-0 text-warn" />}
        {missing && <span className="text-err">missing</span>}
      </div>
      {clip.transitionIn && (
        <div className="absolute top-0 bottom-0 left-0 bg-gradient-to-r from-white/40 to-transparent" style={{ width: Math.max(4, clip.transitionIn.duration * zoom) }} title={`${TRANSITIONS.find((t) => t.type === clip.transitionIn!.type)?.label ?? clip.transitionIn.type} (${clip.transitionIn.duration}f)`} />
      )}
      {clip.fadeIn > 0 && <div className="absolute top-0 left-0 h-full border-l border-white/60" style={{ width: clip.fadeIn * zoom, background: "linear-gradient(to top right, rgba(0,0,0,.45) 50%, transparent 50%)" }} />}
      {clip.fadeOut > 0 && <div className="absolute top-0 right-0 h-full" style={{ width: clip.fadeOut * zoom, background: "linear-gradient(to top left, rgba(0,0,0,.45) 50%, transparent 50%)" }} />}
      {kfFrames.map((f) => (
        <Diamond key={f} size={7} className="absolute bottom-0.5 fill-warn text-warn" style={{ left: f * zoom - 3.5 }} />
      ))}
      {!track.locked && (
        <>
          <div className="absolute top-0 bottom-0 left-0 w-1.5 cursor-ew-resize hover:bg-white/40" onPointerDown={(e) => onPointerDown(e, "start")} />
          <div className="absolute top-0 right-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/40" onPointerDown={(e) => onPointerDown(e, "end")} />
        </>
      )}
    </div>
  );
}

function Waveform({ asset, clip, zoom, fps, width, compact }: { asset: Asset; clip: Clip & { type: "media" }; zoom: number; fps: number; width: number; compact: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<{ peaksPerSecond: number; peaks: number[] } | null>(null);
  useEffect(() => {
    let alive = true;
    void loadWaveform(asset.id, asset.derived.waveform).then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, [asset.id, asset.derived.waveform]);
  useEffect(() => {
    const c = ref.current;
    if (!c || !data) return;
    const w = Math.min(Math.ceil(width), 8000);
    const h = c.clientHeight || 30;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(220,255,235,0.55)";
    const mid = compact ? h - 1 : h / 2;
    for (let x = 0; x < w; x++) {
      const sec = clip.sourceIn + ((x / zoom) / fps) * clip.speed;
      const sec2 = clip.sourceIn + (((x + 1) / zoom) / fps) * clip.speed;
      const i0 = Math.floor(sec * data.peaksPerSecond);
      const i1 = Math.max(i0 + 1, Math.floor(sec2 * data.peaksPerSecond));
      let m = 0;
      for (let i = i0; i < i1 && i < data.peaks.length; i++) m = Math.max(m, data.peaks[i]!);
      const a = (m / 255) * (compact ? h * 0.45 : h * 0.48);
      if (compact) ctx.fillRect(x, mid - a, 1, a);
      else ctx.fillRect(x, mid - a, 1, a * 2);
    }
  }, [data, width, zoom, fps, clip.sourceIn, clip.speed, compact]);
  return <canvas ref={ref} className="pointer-events-none absolute right-0 left-0 bottom-0" style={{ width: "100%", height: compact ? "50%" : "calc(100% - 16px)" }} />;
}

function ClipMenu({ x, y, clipId, onClose }: { x: number; y: number; clipId: string; onClose: () => void }) {
  const { dispatch, playhead, selection, transaction } = useStudio();
  const ids = selection.kind === "clips" ? selection.ids : [clipId];
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onClose]);
  const item = (label: string, fn: () => unknown) => (
    <button
      type="button"
      className="block w-full px-3 py-1 text-left text-[12px] hover:bg-hover"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => {
        void Promise.resolve(fn()).catch(() => {});
        onClose();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="fixed z-50 w-48 rounded border border-line-2 bg-raised py-1 shadow-2xl" style={{ left: x, top: y }}>
      {item("Split at playhead", () => dispatch("clip.split", { clipId, frame: playhead }, "Split"))}
      {item("Duplicate", () => dispatch("clip.duplicate", { clipId }, "Duplicate"))}
      <div className="my-1 h-px bg-line" />
      {item("Cross dissolve in (12f)", () => dispatch("clip.setTransition", { clipId, transition: { type: "crossfade", duration: 12 } }, "Transition"))}
      {item("Flash in (6f)", () => dispatch("clip.setTransition", { clipId, transition: { type: "flash", duration: 6 } }, "Transition"))}
      {item("Remove transition", () => dispatch("clip.setTransition", { clipId, transition: null }, "Remove transition"))}
      <div className="my-1 h-px bg-line" />
      {item(`Delete${ids.length > 1 ? ` ${ids.length} clips` : ""}`, () => dispatch("clip.remove", { clipIds: ids }, "Delete"))}
      {item("Ripple delete", () => transaction("Ripple delete", [{ name: "clip.remove", params: { clipIds: ids, ripple: true } }]))}
    </div>
  );
}
