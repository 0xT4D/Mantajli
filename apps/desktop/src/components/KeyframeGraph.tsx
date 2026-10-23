import { Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { EASINGS, evalKeyframes, type Clip, type Easing, type KeyframeProperty } from "@mantagli/core";
import { useStudio } from "../store/studio";
import { IconButton, Select } from "./ui";

const W = 248;
const H = 92;
const PAD = 8;

/**
 * Curve editor for one keyframed clip property. Points drag in time (x) and
 * value (y); a click selects a point (easing, delete); double-click on the
 * graph adds a key on the curve. Each gesture commits one undoable step.
 */
export function KeyframeGraph({ clip, property }: { clip: Clip; property: KeyframeProperty }) {
  const { transaction, dispatch, setPlayhead, playhead } = useStudio();
  const keys = useMemo(() => [...(clip.keyframes[property] ?? [])].sort((a, b) => a.frame - b.frame), [clip, property]);
  const [sel, setSel] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ index: number; frame: number; value: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);

  const shown = keys.map((k, i) => (drag && drag.index === i ? { ...k, frame: drag.frame, value: drag.value } : k));
  const vals = shown.map((k) => k.value);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 1e-6) {
    const pad = Math.max(Math.abs(hi) * 0.25, property === "opacity" ? 0.5 : 1);
    lo -= pad;
    hi += pad;
  }
  const span = hi - lo;
  lo -= span * 0.12;
  hi += span * 0.12;
  const dur = Math.max(1, clip.duration);
  const x = (f: number) => PAD + (f / dur) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD);
  const toFrame = (px: number) => Math.round(((px - PAD) / (W - 2 * PAD)) * dur);
  const toValue = (py: number) => lo + ((H - PAD - py) / (H - 2 * PAD)) * (hi - lo);

  const path = useMemo(() => {
    const pts: string[] = [];
    for (let i = 0; i <= 80; i++) {
      const f = (i / 80) * dur;
      pts.push(`${i === 0 ? "M" : "L"}${x(f).toFixed(1)},${y(evalKeyframes(shown, f, 0)).toFixed(1)}`);
    }
    return pts.join(" ");
  }, [shown, dur, lo, hi]); // eslint-disable-line react-hooks/exhaustive-deps

  const local = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return { px: ((e.clientX - r.left) / r.width) * W, py: ((e.clientY - r.top) / r.height) * H };
  };

  const commitMove = async (index: number, frame: number, value: number) => {
    const k = keys[index]!;
    const f = Math.max(0, Math.min(dur, frame));
    if (f === k.frame && Math.abs(value - k.value) < 1e-9) return;
    // Another key already on the target frame is replaced by the moved one.
    await transaction(`Edit ${property} keyframe`, [
      { name: "keyframe.remove", params: { clipId: clip.id, property, frame: k.frame } },
      { name: "keyframe.set", params: { clipId: clip.id, property, keyframe: { frame: f, value: round(value), easing: k.easing } } },
    ]).catch(() => {});
    setSel(f);
  };

  const selected = keys.find((k) => k.frame === sel);
  const playLocal = playhead - clip.start;

  return (
    <div className="space-y-1">
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full cursor-crosshair rounded border border-line bg-bg"
        onDoubleClick={(e) => {
          const { px } = local(e);
          const f = Math.max(0, Math.min(dur, toFrame(px)));
          void dispatch("keyframe.set", { clipId: clip.id, property, keyframe: { frame: f, value: round(evalKeyframes(keys, f, 0)), easing: "easeInOut" } }, `Add ${property} keyframe`).catch(() => {});
          setSel(f);
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const { px, py } = local(e);
          setDrag({ index: drag.index, frame: Math.max(0, Math.min(dur, toFrame(px))), value: e.shiftKey ? keys[drag.index]!.value : toValue(py) });
        }}
        onPointerUp={() => {
          if (drag) void commitMove(drag.index, drag.frame, drag.value);
          setDrag(null);
        }}
        onPointerLeave={() => {
          if (drag) void commitMove(drag.index, drag.frame, drag.value);
          setDrag(null);
        }}
      >
        <line x1={PAD} x2={W - PAD} y1={y(lo + (hi - lo) / 2)} y2={y(lo + (hi - lo) / 2)} stroke="var(--color-line)" strokeDasharray="2 3" />
        {playLocal >= 0 && playLocal <= dur && <line x1={x(playLocal)} x2={x(playLocal)} y1={0} y2={H} stroke="var(--color-accent)" strokeWidth={1} />}
        <path d={path} fill="none" stroke="var(--color-warn)" strokeWidth={1.5} />
        {shown.map((k, i) => (
          <rect
            key={i}
            x={x(k.frame) - 4}
            y={y(k.value) - 4}
            width={8}
            height={8}
            transform={`rotate(45 ${x(k.frame)} ${y(k.value)})`}
            className="cursor-grab"
            fill={keys[i]!.frame === sel ? "var(--color-warn)" : "var(--color-panel)"}
            stroke="var(--color-warn)"
            strokeWidth={1.5}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.target as Element).setPointerCapture?.(e.pointerId);
              setSel(keys[i]!.frame);
              setDrag({ index: i, frame: keys[i]!.frame, value: keys[i]!.value });
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setPlayhead(clip.start + keys[i]!.frame);
            }}
          >
            <title>{`${property} ${round(k.value)} @ ${k.frame}f (${k.easing})`}</title>
          </rect>
        ))}
      </svg>
      <div className="flex items-center gap-1 text-[10px] text-mute">
        <span className="tabular">{round(hi)}</span>
        <span className="flex-1" />
        {selected ? (
          <>
            <span className="tabular text-dim">
              {selected.frame}f = {round(selected.value)}
            </span>
            <Select<Easing>
              value={selected.easing}
              onChange={(v) => void dispatch("keyframe.set", { clipId: clip.id, property, keyframe: { ...selected, easing: v } }, "Keyframe easing").catch(() => {})}
              options={EASINGS.map((e) => ({ value: e, label: e }))}
              className="max-w-24 flex-none"
            />
            <IconButton size={20} icon={<Trash2 size={11} />} label="Delete keyframe" onClick={() => void dispatch("keyframe.remove", { clipId: clip.id, property, frame: selected.frame }, "Delete keyframe").then(() => setSel(null)).catch(() => {})} />
          </>
        ) : (
          <span>Drag points · double-click to add · Shift locks value</span>
        )}
      </div>
    </div>
  );
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
