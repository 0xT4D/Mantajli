import { Film, Image as ImageIcon, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import { clipEnd, fpsValue, LOOKS, TRANSITIONS } from "@mantagli/core";
import { useStudio } from "../store/studio";
import { Button, cx, Dialog, NumberField, Row, Select, Slider } from "./ui";

/**
 * One-click montage: cut the selected footage to the beat markers over a
 * range of a track (core command timeline.autoEdit, one undo step).
 */
export function AutoEditDialog() {
  const { session, setDialog, dispatch, playhead, toast, setSelection } = useStudio();
  const p = session.project!;
  const fps = fpsValue(p.settings.fps);
  const footage = p.assets.filter((a) => (a.kind === "video" || a.kind === "image") && a.status === "ok");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(footage.filter((a) => a.kind === "video").map((a) => a.id)));
  const visualTracks = p.tracks.filter((t) => t.kind === "video" && !t.locked);
  const [trackId, setTrackId] = useState(visualTracks.find((t) => t.name === "V1")?.id ?? visualTracks[0]?.id ?? "");
  // Default range: from the playhead to the end of the music (or 15 s).
  const musicEnd = Math.max(0, ...p.tracks.filter((t) => t.role === "music").flatMap((t) => t.clips.map(clipEnd)));
  const [startSec, setStartSec] = useState(Math.round((playhead / fps) * 100) / 100);
  const [endSec, setEndSec] = useState(Math.round(((musicEnd > playhead ? musicEnd : playhead + 15 * fps) / fps) * 100) / 100);
  const [every, setEvery] = useState("2");
  const [on, setOn] = useState<"beats" | "downbeats">("beats");
  const [transition, setTransition] = useState("none");
  const [look, setLook] = useState("none");
  const [pulse, setPulse] = useState(0.06);
  const start = Math.round(startSec * fps);
  const end = Math.round(endSec * fps);
  const beatsInRange = useMemo(
    () => p.markers.filter((m) => (on === "downbeats" ? m.kind === "downbeat" : m.kind === "beat" || m.kind === "downbeat") && m.frame > start && m.frame < end).length,
    [p.markers, on, start, end],
  );
  const shots = Math.floor(beatsInRange / Number(every)) + 1;
  const ids = footage.filter((a) => picked.has(a.id)).map((a) => a.id);
  const ready = ids.length > 0 && trackId && end > start && beatsInRange > 0;

  const run = async () => {
    const r = await dispatch(
      "timeline.autoEdit",
      {
        trackId,
        assetIds: ids,
        start,
        end,
        every: Number(every),
        on,
        transition: transition === "none" ? null : { type: transition, duration: 6 },
        look: look === "none" ? undefined : look,
        pulse,
      },
      "Auto edit to beats",
    ).catch(() => null);
    if (!r) return;
    toast("ok", `Cut ${(r as { shots: number }).shots} shots to the beat (undo with Ctrl+Z)`);
    setSelection({ kind: "clips", ids: (r as { clipIds: string[] }).clipIds });
    setDialog(null);
  };

  return (
    <Dialog
      title="Auto edit to beats"
      width={560}
      onClose={() => setDialog(null)}
      footer={
        <>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void run()}>
            <Wand2 size={13} /> Cut {ready ? `${shots} shots` : ""}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <div className="text-[11px] font-semibold text-dim">Footage ({ids.length} selected, used in order and repeated)</div>
        <div className="max-h-40 space-y-0.5 overflow-auto rounded border border-line p-1">
          {footage.length === 0 && <div className="p-2 text-[11px] text-mute">Import video or images first.</div>}
          {footage.map((a) => (
            <label key={a.id} className={cx("flex cursor-pointer items-center gap-2 rounded px-1.5 py-0.5 text-[11px]", picked.has(a.id) ? "bg-accent/10" : "hover:bg-hover")}>
              <input
                type="checkbox"
                checked={picked.has(a.id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(a.id);
                  else next.delete(a.id);
                  setPicked(next);
                }}
              />
              {a.kind === "video" ? <Film size={11} className="text-mute" /> : <ImageIcon size={11} className="text-mute" />}
              <span className="flex-1 truncate">{a.name}</span>
              {a.meta.duration !== undefined && <span className="tabular text-mute">{a.meta.duration.toFixed(1)}s</span>}
            </label>
          ))}
        </div>
        <Row label="Track">
          <Select value={trackId} onChange={setTrackId} options={visualTracks.map((t) => ({ value: t.id, label: t.name }))} />
        </Row>
        <Row label="Range (s)">
          <NumberField value={startSec} min={0} step={0.1} unit="s" onChange={setStartSec} />
          <NumberField value={endSec} min={0} step={0.1} unit="s" onChange={setEndSec} />
        </Row>
        <Row label="Cut every">
          <Select value={every} onChange={setEvery} options={["1", "2", "4", "8"].map((n) => ({ value: n, label: `${n} ${n === "1" ? "marker" : "markers"}` }))} />
          <Select value={on} onChange={(v) => setOn(v)} options={[{ value: "beats", label: "Beats" }, { value: "downbeats", label: "Downbeats (bars)" }]} />
        </Row>
        <Row label="Transition">
          <Select value={transition} onChange={setTransition} options={[{ value: "none", label: "Hard cut" }, ...TRANSITIONS.map((t) => ({ value: t.type, label: t.label }))]} />
        </Row>
        <Row label="Look">
          <Select value={look} onChange={setLook} options={[{ value: "none", label: "None" }, ...LOOKS.map((l) => ({ value: l.id, label: l.label }))]} />
        </Row>
        <Row label="Beat pulse" title="Zoom punch on each beat inside every shot">
          <Slider value={pulse} min={0} max={0.3} step={0.01} onChange={setPulse} />
        </Row>
        <div className={cx("rounded border p-2 text-[11px]", beatsInRange ? "border-line text-dim" : "border-warn/40 text-warn")}>
          {beatsInRange
            ? `${beatsInRange} ${on === "downbeats" ? "downbeat" : "beat"} markers in range → ${shots} shots replacing what is on the track there.`
            : "No beat markers in this range. Select the music in the media bin and run beat detection first."}
        </div>
      </div>
    </Dialog>
  );
}
