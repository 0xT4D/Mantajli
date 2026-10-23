import { Box, ChevronFirst, ChevronLast, Film, Grid3x3, Pause, Play, StepBack, StepForward } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatTimecode, fpsValue, projectDuration } from "@mantagli/core";
import { engine } from "../engine/client";
import { LiveCompositor } from "../lib/liveCompositor";
import { useStudio } from "../store/studio";
import { Button, cx, Dialog, IconButton, Select } from "./ui";

type Mode = "live" | "rendering" | "rendered" | "error";

const SCALES = [
  { value: "0.25", label: "Draft ¼" },
  { value: "0.5", label: "Preview ½" },
  { value: "0.75", label: "High ¾" },
  { value: "1", label: "Full" },
];

export function Viewer() {
  const project = useStudio((s) => s.session.project);
  const dir = useStudio((s) => s.session.dir);
  const { playhead, playing, setPlayhead, setPlaying, info, call, jobs } = useStudio();
  const scale = info?.settings.previewScale ?? 0.5;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositor = useRef<LiveCompositor | null>(null);
  const [box, setBox] = useState({ w: 400, h: 300 });
  const [zoomMode, setZoomMode] = useState<"fit" | "50" | "100">("fit");
  const [guides, setGuides] = useState(false);
  const [mode, setMode] = useState<Mode>("live");
  const [still, setStill] = useState<{ url: string; frame: number; projectStamp: string } | null>(null);
  const [sceneMissing, setSceneMissing] = useState(false);
  const [rangeVideo, setRangeVideo] = useState<string | null>(null);
  const frameRef = useRef(playhead);
  frameRef.current = playhead;

  if (!compositor.current) compositor.current = new LiveCompositor(() => useStudio.getState().session.dir);

  // Fit canvas to the available area keeping the project aspect.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pw = project?.settings.width ?? 1080;
  const ph = project?.settings.height ?? 1920;
  const fit = Math.min((box.w - 24) / pw, (box.h - 24) / ph);
  const viewScale = zoomMode === "fit" ? fit : zoomMode === "50" ? 0.5 : 1;
  const cssW = Math.max(16, Math.round(pw * viewScale));
  const cssH = Math.max(16, Math.round(ph * viewScale));
  const pxW = Math.round(cssW * Math.min(2, window.devicePixelRatio || 1));
  const pxH = Math.round(cssH * Math.min(2, window.devicePixelRatio || 1));

  const redraw = useCallback(() => {
    const c = canvasRef.current;
    const p = useStudio.getState().session.project;
    if (!c || !p) return;
    const r = compositor.current!.draw(c.getContext("2d")!, p, frameRef.current, useStudio.getState().playing);
    setSceneMissing(r.sceneMissing);
  }, []);
  useEffect(() => {
    compositor.current!.onNeedsRedraw = () => requestAnimationFrame(redraw);
  }, [redraw]);
  useEffect(() => () => compositor.current?.dispose(), []);

  // Locate cached draft 3D frames so live playback can show them.
  const sceneKey = JSON.stringify(project?.scenes ?? []) + JSON.stringify(Object.values(jobs).filter((j) => j.type === "scene" && j.status === "done").length);
  useEffect(() => {
    if (!project) return;
    let alive = true;
    void (async () => {
      for (const s of project.scenes) {
        try {
          const r = await engine.call<{ dir: string; frames: number }>("render.sceneCache", { sceneId: s.id, quality: "draft", scale });
          if (alive && r.frames > 0) compositor.current!.sceneDirs.set(s.id, r.dir);
          else compositor.current!.sceneDirs.delete(s.id);
        } catch {
          /* scene removed */
        }
      }
      if (alive) redraw();
    })();
    return () => {
      alive = false;
    };
  }, [sceneKey, scale, redraw]); // eslint-disable-line react-hooks/exhaustive-deps

  // Playback clock.
  useEffect(() => {
    if (!playing || !project) return;
    setMode("live");
    const fps = fpsValue(project.settings.fps);
    const total = projectDuration(project);
    const t0 = performance.now();
    const f0 = frameRef.current >= total - 1 ? 0 : frameRef.current;
    let raf = 0;
    const tick = () => {
      const f = f0 + Math.floor(((performance.now() - t0) / 1000) * fps);
      if (f >= total) {
        setPlaying(false);
        setPlayhead(total - 1);
        return;
      }
      if (f !== frameRef.current) {
        frameRef.current = f;
        setPlayhead(f);
      }
      redraw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      compositor.current!.stopAll();
      redraw();
    };
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Paused: draw live immediately, then fetch the exact rendered frame.
  const stamp = project ? `${project.modifiedAt}:${scale}` : "";
  useEffect(() => {
    if (playing || !project) return;
    redraw();
    if (still && still.frame === playhead && still.projectStamp === stamp) {
      setMode("rendered");
      return;
    }
    setMode("live");
    if (!info?.deps.ffmpeg) return;
    const t = setTimeout(async () => {
      setMode("rendering");
      try {
        const r = await engine.call<{ path: string; frame: number }>("render.still", { frame: playhead, scale });
        if (frameRef.current === playhead && !useStudio.getState().playing) {
          setStill({ url: engine.fileUrl(r.path, Date.now())!, frame: playhead, projectStamp: stamp });
          setMode("rendered");
        }
      } catch {
        setMode("error");
      }
    }, 350);
    return () => clearTimeout(t);
  }, [playhead, playing, stamp, pxW, pxH]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!project) return null;
  const fps = fpsValue(project.settings.fps);
  const total = projectDuration(project);
  const busyScene = Object.values(jobs).some((j) => j.type === "scene" && (j.status === "running" || j.status === "queued"));

  const renderScenes = async () => {
    for (const s of project.scenes) await call("render.scene", { sceneId: s.id, quality: "draft", scale }).catch(() => {});
  };
  const renderRange = async () => {
    const r = await call<{ path: string }>("render.range", { start: 0, end: total, scale: Math.min(scale, 0.5) }).catch(() => null);
    if (r) setRangeVideo(engine.fileUrl(r.path, Date.now())!);
  };

  const badge =
    mode === "rendered"
      ? { text: "Rendered frame · exact", cls: "bg-ok/15 text-ok" }
      : mode === "rendering"
        ? { text: "Rendering exact frame…", cls: "bg-accent/15 text-accent-2" }
        : mode === "error"
          ? { text: "Render failed · showing live", cls: "bg-err/15 text-err" }
          : { text: playing ? "Live · approximate · proxies" : "Live · approximate", cls: "bg-warn/15 text-warn" };

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line bg-panel px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-dim">Viewer</span>
        <span className={cx("rounded px-1.5 py-0.5 text-[10px] font-medium", badge.cls)}>{badge.text}</span>
        {sceneMissing && project.scenes.length > 0 && <span className="rounded bg-clip-scene/20 px-1.5 py-0.5 text-[10px] text-[#e0b090]">3D not pre-rendered for live playback</span>}
        <div className="flex-1" />
        {project.scenes.length > 0 && (
          <Button variant="ghost" onClick={() => void renderScenes()} disabled={busyScene || !info?.deps.blender} title={info?.deps.blender ? "Render draft frames of all 3D scenes with Blender for live playback" : "Blender not available"}>
            <Box size={13} /> {busyScene ? "Rendering 3D…" : "Render 3D previews"}
          </Button>
        )}
        <Button variant="ghost" onClick={() => void renderRange()} title="Render the whole timeline to a draft video (exact compositing)">
          <Film size={13} /> Render preview video
        </Button>
        <Select value={String(scale) as "0.5"} onChange={(v) => void useStudio.getState().updateSettings({ previewScale: Number(v) })} options={SCALES as { value: "0.5"; label: string }[]} className="max-w-24 flex-none" />
        <Select value={zoomMode} onChange={setZoomMode} options={[{ value: "fit", label: "Fit" }, { value: "50", label: "50%" }, { value: "100", label: "100%" }]} className="max-w-16 flex-none" />
        <IconButton icon={<Grid3x3 size={14} />} label="Safe-area guides" active={guides} onClick={() => setGuides(!guides)} />
      </div>

      <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-auto">
        <div className="flex min-h-full min-w-full items-center justify-center p-3">
          <div className="relative shadow-[0_0_0_1px_var(--color-line-2)]" style={{ width: cssW, height: cssH }}>
            <canvas ref={canvasRef} width={pxW} height={pxH} style={{ width: cssW, height: cssH }} className="block" />
            {mode === "rendered" && still && <img src={still.url} alt="" className="absolute inset-0 h-full w-full" draggable={false} />}
            {guides && (
              <div className="pointer-events-none absolute inset-0">
                <div className="absolute border border-dashed border-white/30" style={{ inset: "5%" }} />
                <div className="absolute border border-dashed border-accent/40" style={{ inset: "10%" }} />
                <div className="absolute top-1/3 right-0 left-0 h-px bg-white/15" />
                <div className="absolute top-2/3 right-0 left-0 h-px bg-white/15" />
                <div className="absolute top-0 bottom-0 left-1/3 w-px bg-white/15" />
                <div className="absolute top-0 bottom-0 left-2/3 w-px bg-white/15" />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex h-9 shrink-0 items-center justify-center gap-1 border-t border-line bg-panel">
        <IconButton icon={<ChevronFirst size={15} />} label="Go to start" shortcut="Home" onClick={() => setPlayhead(0)} />
        <IconButton icon={<StepBack size={15} />} label="Previous frame" shortcut="←" onClick={() => setPlayhead(playhead - 1)} />
        <IconButton icon={playing ? <Pause size={16} /> : <Play size={16} />} label={playing ? "Pause" : "Play"} shortcut="Space" onClick={() => setPlaying(!playing)} size={32} className="text-fg" />
        <IconButton icon={<StepForward size={15} />} label="Next frame" shortcut="→" onClick={() => setPlayhead(Math.min(total - 1, playhead + 1))} />
        <IconButton icon={<ChevronLast size={15} />} label="Go to end" shortcut="End" onClick={() => setPlayhead(total - 1)} />
        <span className="tabular ml-3 font-mono text-[12px] text-fg">{formatTimecode(playhead, project.settings.fps)}</span>
        <span className="tabular font-mono text-[11px] text-mute">
          · {(playhead / fps).toFixed(2)}s · {project.settings.width}×{project.settings.height} @ {fps.toFixed(2).replace(/\.00$/, "")}
        </span>
      </div>

      {rangeVideo && (
        <Dialog title="Rendered preview (draft)" onClose={() => setRangeVideo(null)} width={Math.min(900, Math.max(360, (pw / ph) * 560 + 40))}>
          <video src={rangeVideo} controls autoPlay className="mx-auto max-h-[60vh] bg-black" />
          <div className="mt-2 text-[11px] text-mute">Exact composition (FFmpeg + Blender draft 3D) at reduced resolution. Re-render after edits.</div>
        </Dialog>
      )}
    </div>
  );
}
