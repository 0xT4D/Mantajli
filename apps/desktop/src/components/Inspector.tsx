import { ArrowDown, ArrowUp, Box, Camera, Diamond, Eye, EyeOff, Lightbulb, Plus, Shapes, Sparkle, Trash2, Type } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  clipPropertyAt,
  EFFECTS,
  effectSpec,
  formatTimecode,
  fpsValue,
  KEYFRAME_PROPERTIES,
  MATERIAL_PRESETS,
  MESH_PRIMITIVES,
  TEXT_ANIMATIONS,
  TRANSITIONS,
  type Clip,
  type CommandName,
  type KeyframeProperty,
  type Project,
  type Scene,
  type SceneObject,
  type Track,
} from "@mantagli/core";
import { engine } from "../engine/client";
import { KeyframeGraph } from "./KeyframeGraph";
import { useStudio } from "../store/studio";
import { Button, ColorField, cx, Empty, IconButton, NumberField, PanelHeader, Row, Section, Select, Slider, TextField, Toggle } from "./ui";

export function Inspector() {
  const project = useStudio((s) => s.session.project);
  const selection = useStudio((s) => s.selection);
  if (!project) return null;
  let body: ReactNode;
  let title = "Inspector";
  switch (selection.kind) {
    case "clips": {
      const clips = selection.ids.map((id) => findClip(project, id)).filter(Boolean) as { clip: Clip; track: Track }[];
      if (clips.length === 1) {
        title = `${clips[0]!.clip.type === "media" ? "Clip" : clips[0]!.clip.type === "text" ? "Text" : clips[0]!.clip.type === "scene" ? "3D clip" : "Colour"} · ${clips[0]!.clip.name || ""}`;
        body = <ClipInspector key={clips[0]!.clip.id} project={project} clip={clips[0]!.clip} track={clips[0]!.track} />;
      } else if (clips.length > 1) body = <MultiClipInspector clips={clips.map((c) => c.clip)} />;
      else body = <Empty title="Selection no longer exists" />;
      break;
    }
    case "track": {
      const t = project.tracks.find((x) => x.id === selection.id);
      title = "Track";
      body = t ? <TrackInspector track={t} /> : <Empty title="Track removed" />;
      break;
    }
    case "scene":
    case "sceneObject": {
      const sceneId = selection.kind === "scene" ? selection.id : selection.sceneId;
      const s = project.scenes.find((x) => x.id === sceneId);
      title = s ? `3D scene · ${s.name}` : "3D scene";
      body = s ? <SceneInspector project={project} scene={s} objectId={selection.kind === "sceneObject" ? selection.id : undefined} /> : <Empty title="Scene removed" />;
      break;
    }
    case "marker": {
      const m = project.markers.find((x) => x.id === selection.id);
      title = "Marker";
      body = m ? <MarkerInspector markerId={m.id} /> : <Empty title="Marker removed" />;
      break;
    }
    default:
      title = "Project";
      body = <ProjectInspector project={project} />;
  }
  return (
    <div className="flex h-full flex-col bg-panel">
      <PanelHeader title={title} />
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  );
}

function findClip(p: Project, id: string): { clip: Clip; track: Track } | undefined {
  for (const track of p.tracks) {
    const clip = track.clips.find((c) => c.id === id);
    if (clip) return { clip, track };
  }
}

function useCmd() {
  const dispatch = useStudio((s) => s.dispatch);
  return <N extends CommandName>(name: N, params: Parameters<typeof dispatch<N>>[1], label?: string) => void dispatch(name, params, label).catch(() => {});
}

// ------------------------------------------------------------------ clips

function KeyButton({ clip, prop }: { clip: Clip; prop: KeyframeProperty }) {
  const playhead = useStudio((s) => s.playhead);
  const cmd = useCmd();
  const local = playhead - clip.start;
  const inRange = local >= 0 && local <= clip.duration;
  const has = clip.keyframes[prop]?.some((k) => k.frame === local);
  const any = !!clip.keyframes[prop]?.length;
  return (
    <IconButton
      size={22}
      icon={<Diamond size={11} className={cx(has ? "fill-warn text-warn" : any ? "text-warn" : "")} />}
      label={has ? `Remove ${prop} keyframe at playhead` : `Add ${prop} keyframe at playhead`}
      disabled={!inRange}
      onClick={() =>
        has
          ? cmd("keyframe.remove", { clipId: clip.id, property: prop, frame: local }, "Remove keyframe")
          : cmd("keyframe.set", { clipId: clip.id, property: prop, keyframe: { frame: local, value: clipPropertyAt(clip, prop, local), easing: "easeInOut" } }, "Add keyframe")
      }
    />
  );
}

/** Edits a keyframable property: sets the keyframe at the playhead if animated, else the base value. */
function useAnimatedSetter(clip: Clip) {
  const playhead = useStudio((s) => s.playhead);
  const cmd = useCmd();
  const local = Math.max(0, Math.min(clip.duration, playhead - clip.start));
  return {
    value: (prop: KeyframeProperty) => clipPropertyAt(clip, prop, local),
    set: (prop: KeyframeProperty, v: number) => {
      if (clip.keyframes[prop]?.length) cmd("keyframe.set", { clipId: clip.id, property: prop, keyframe: { frame: local, value: v, easing: "easeInOut" } }, `Keyframe ${prop}`);
      else if (prop === "opacity") cmd("clip.update", { clipId: clip.id, props: { opacity: v } }, "Opacity");
      else if (prop === "volume") cmd("clip.update", { clipId: clip.id, props: { volumeDb: v } }, "Volume");
      else cmd("clip.update", { clipId: clip.id, props: { transform: { [prop]: v } } }, `Transform ${prop}`);
    },
  };
}

function ClipInspector({ project, clip, track }: { project: Project; clip: Clip; track: Track }) {
  const cmd = useCmd();
  const fps = fpsValue(project.settings.fps);
  const a = useAnimatedSetter(clip);
  const asset = clip.type === "media" ? project.assets.find((x) => x.id === clip.assetId) : undefined;
  const isAudio = track.kind === "audio" || asset?.kind === "audio";
  const upd = (props: Record<string, unknown>, label: string) => cmd("clip.update", { clipId: clip.id, props: props as never }, label);
  return (
    <div>
      <Section title="Clip">
        <Row label="Name">
          <TextField value={clip.name} onCommit={(v) => upd({ name: v }, "Rename clip")} />
        </Row>
        <Row label="Start" title={formatTimecode(clip.start, project.settings.fps)}>
          <NumberField value={clip.start} min={0} step={1} unit="f" onChange={(v) => cmd("clip.move", { clipId: clip.id, start: v }, "Move clip")} />
          <span className="tabular w-16 text-right font-mono text-[10px] text-mute">{(clip.start / fps).toFixed(2)}s</span>
        </Row>
        <Row label="Duration">
          <NumberField value={clip.duration} min={1} step={1} unit="f" onChange={(v) => cmd("clip.trim", { clipId: clip.id, edge: "end", frame: clip.start + v }, "Trim clip")} />
          <span className="tabular w-16 text-right font-mono text-[10px] text-mute">{(clip.duration / fps).toFixed(2)}s</span>
        </Row>
        {(clip.type === "media" || clip.type === "scene") && (
          <Row label="Source in">
            <NumberField value={clip.sourceIn} min={0} step={0.01} unit="s" onChange={(v) => upd({ sourceIn: v }, "Source in")} />
          </Row>
        )}
        {clip.type === "media" && !isAudio && asset?.kind !== "image" && (
          <Row label="Speed" title="Playback speed; duration stays fixed and the source range changes">
            <Slider value={clip.speed} min={0.1} max={4} step={0.05} unit="×" onChange={(v) => upd({ speed: v }, "Speed")} />
          </Row>
        )}
        {clip.type === "media" && isAudio && (
          <Row label="Speed">
            <Slider value={clip.speed} min={0.5} max={2} step={0.05} unit="×" onChange={(v) => upd({ speed: v }, "Speed")} />
          </Row>
        )}
        {asset && <div className="truncate text-[10px] text-mute" title={asset.path}>Source: {asset.name}</div>}
      </Section>

      {clip.type === "text" && <TextSection clip={clip} upd={upd} />}
      {clip.type === "color" && (
        <Section title="Fill">
          <Row label="Colour">
            <ColorField value={clip.fill} onChange={(v) => upd({ fill: v }, "Colour")} />
          </Row>
        </Section>
      )}
      {clip.type === "scene" && (
        <Section title="3D scene">
          <div className="text-[11px]">{project.scenes.find((s) => s.id === clip.sceneId)?.name ?? "missing scene"}</div>
          <Button onClick={() => useStudio.getState().setSelection({ kind: "scene", id: clip.sceneId })}>
            <Box size={12} /> Edit scene
          </Button>
        </Section>
      )}

      {!isAudio && (
        <Section title="Transform">
          {(["x", "y"] as const).map((p) => (
            <Row key={p} label={p === "x" ? "Position X" : "Position Y"}>
              <NumberField value={a.value(p)} step={1} unit="px" onChange={(v) => a.set(p, v)} />
              <KeyButton clip={clip} prop={p} />
            </Row>
          ))}
          <Row label="Scale">
            <NumberField value={a.value("scale")} min={0.01} max={20} step={0.01} onChange={(v) => a.set("scale", v)} />
            <KeyButton clip={clip} prop="scale" />
          </Row>
          <Row label="Rotation">
            <NumberField value={a.value("rotation")} step={0.5} unit="°" onChange={(v) => a.set("rotation", v)} />
            <KeyButton clip={clip} prop="rotation" />
          </Row>
          <Row label="Opacity">
            <Slider value={a.value("opacity")} min={0} max={1} step={0.01} onChange={(v) => a.set("opacity", v)} />
            <KeyButton clip={clip} prop="opacity" />
          </Row>
          {clip.type === "media" && (
            <>
              <Row label="Fit">
                <Select value={clip.transform.fit} onChange={(v) => upd({ transform: { fit: v } }, "Fit")} options={[{ value: "fill", label: "Fill frame" }, { value: "fit", label: "Fit inside" }, { value: "stretch", label: "Stretch" }]} />
              </Row>
              <Row label="Crop L / R">
                <NumberField value={clip.transform.crop.left} min={0} max={0.45} step={0.01} onChange={(v) => upd({ transform: { crop: { left: v } } }, "Crop")} />
                <NumberField value={clip.transform.crop.right} min={0} max={0.45} step={0.01} onChange={(v) => upd({ transform: { crop: { right: v } } }, "Crop")} />
              </Row>
              <Row label="Crop T / B">
                <NumberField value={clip.transform.crop.top} min={0} max={0.45} step={0.01} onChange={(v) => upd({ transform: { crop: { top: v } } }, "Crop")} />
                <NumberField value={clip.transform.crop.bottom} min={0} max={0.45} step={0.01} onChange={(v) => upd({ transform: { crop: { bottom: v } } }, "Crop")} />
              </Row>
            </>
          )}
        </Section>
      )}

      {clip.type === "media" && (isAudio || asset?.meta.hasAudio) && (
        <Section title="Audio">
          {!isAudio && (
            <Row label="Clip audio">
              <Toggle checked={clip.audioEnabled} onChange={(v) => upd({ audioEnabled: v }, "Clip audio")} label={clip.audioEnabled ? "On" : "Muted"} />
            </Row>
          )}
          <Row label="Gain">
            <Slider value={a.value("volume")} min={-60} max={12} step={0.5} unit="dB" onChange={(v) => a.set("volume", v)} />
            <KeyButton clip={clip} prop="volume" />
          </Row>
        </Section>
      )}

      <Section title="Fades & transition">
        <Row label="Fade in">
          <NumberField value={clip.fadeIn} min={0} max={clip.duration} step={1} unit="f" onChange={(v) => upd({ fadeIn: v }, "Fade in")} />
        </Row>
        <Row label="Fade out">
          <NumberField value={clip.fadeOut} min={0} max={clip.duration} step={1} unit="f" onChange={(v) => upd({ fadeOut: v }, "Fade out")} />
        </Row>
        {!isAudio && (
          <>
            <Row label="Transition in">
              <Select
                value={clip.transitionIn?.type ?? "none"}
                onChange={(v) => cmd("clip.setTransition", { clipId: clip.id, transition: v === "none" ? null : { type: v, duration: Math.min(clip.duration, clip.transitionIn?.duration ?? 12) } }, "Transition")}
                options={[{ value: "none", label: "Cut" }, ...TRANSITIONS.map((t) => ({ value: t.type, label: t.label }))]}
              />
            </Row>
            {clip.transitionIn && (
              <Row label="Length">
                <NumberField value={clip.transitionIn.duration} min={1} max={clip.duration} step={1} unit="f" onChange={(v) => cmd("clip.setTransition", { clipId: clip.id, transition: { type: clip.transitionIn!.type, duration: v } }, "Transition length")} />
              </Row>
            )}
          </>
        )}
      </Section>

      {!isAudio && <EffectsSection clip={clip} project={project} />}
      <KeyframesSection clip={clip} />
    </div>
  );
}

function TextSection({ clip, upd }: { clip: Clip & { type: "text" }; upd: (p: Record<string, unknown>, l: string) => void }) {
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => {
    void engine.call<string[]>("app.fonts").then(setFonts).catch(() => setFonts(["Arial"]));
  }, []);
  const s = clip.style;
  const st = (patch: Record<string, unknown>) => upd({ style: patch }, "Text style");
  const project = useStudio((x) => x.session.project)!;
  const fontAssets = project.assets.filter((a) => a.kind === "font");
  return (
    <>
      <Section title="Text">
        <TextField multiline value={clip.text} onCommit={(v) => v.trim() && upd({ text: v }, "Edit text")} />
        <Row label="Font">
          <Select
            value={s.fontAssetId ? `asset:${s.fontAssetId}` : s.fontFamily}
            onChange={(v) => (v.startsWith("asset:") ? st({ fontAssetId: v.slice(6) }) : st({ fontFamily: v, fontAssetId: undefined }))}
            options={[...fonts.map((f) => ({ value: f, label: f })), ...fontAssets.map((f) => ({ value: `asset:${f.id}`, label: `${f.name} (imported)` }))]}
          />
          <Toggle checked={s.bold} onChange={(v) => st({ bold: v })} label="Bold" />
        </Row>
        <Row label="Size">
          <NumberField value={s.fontSize} min={4} max={1000} step={1} unit="px" onChange={(v) => st({ fontSize: v })} />
        </Row>
        <Row label="Colour">
          <ColorField value={s.color} onChange={(v) => st({ color: v })} />
        </Row>
        <Row label="Align">
          <Select value={s.align} onChange={(v) => st({ align: v })} options={[{ value: "left", label: "Left" }, { value: "center", label: "Centre" }, { value: "right", label: "Right" }]} />
        </Row>
        <Row label="Outline">
          <NumberField value={s.strokeWidth} min={0} max={40} step={0.5} unit="px" onChange={(v) => st({ strokeWidth: v })} />
          <ColorField value={s.strokeColor} onChange={(v) => st({ strokeColor: v })} />
        </Row>
        <Row label="Shadow">
          <Toggle checked={s.shadow} onChange={(v) => st({ shadow: v })} />
          <ColorField value={s.shadowColor} onChange={(v) => st({ shadowColor: v })} />
        </Row>
        <Row label="Box">
          <Toggle checked={s.box} onChange={(v) => st({ box: v })} />
          <ColorField value={s.boxColor} onChange={(v) => st({ boxColor: v })} />
        </Row>
        {s.box && (
          <Row label="Box opacity">
            <Slider value={s.boxOpacity} min={0} max={1} step={0.05} onChange={(v) => st({ boxOpacity: v })} />
          </Row>
        )}
      </Section>
      <Section title="Text animation">
        <Row label="In">
          <Select value={clip.animation.in} onChange={(v) => upd({ animation: { in: v } }, "Text animation")} options={TEXT_ANIMATIONS.map((t) => ({ value: t, label: t }))} />
        </Row>
        <Row label="Out">
          <Select value={clip.animation.out} onChange={(v) => upd({ animation: { out: v } }, "Text animation")} options={TEXT_ANIMATIONS.map((t) => ({ value: t, label: t }))} />
        </Row>
        <Row label="Length">
          <NumberField value={clip.animation.duration} min={1} max={300} step={1} unit="f" onChange={(v) => upd({ animation: { duration: v } }, "Text animation")} />
        </Row>
      </Section>
    </>
  );
}

function EffectsSection({ clip, project }: { clip: Clip; project: Project }) {
  const cmd = useCmd();
  const [adding, setAdding] = useState("");
  const luts = project.assets.filter((a) => a.kind === "lut");
  return (
    <Section
      title={`Effects (${clip.effects.length})`}
      right={
        <select
          className="h-5 rounded border border-line bg-bg text-[10px]"
          value={adding}
          onChange={(e) => {
            const type = e.target.value;
            setAdding("");
            if (!type) return;
            if (type === "lut" && !luts.length) return useStudio.getState().toast("info", "Import a .cube LUT first");
            cmd("effect.add", { clipId: clip.id, type, params: type === "lut" ? { assetId: luts[0]!.id } : {} }, `Add ${type}`);
          }}
        >
          <option value="">+ Add effect</option>
          {(["color", "stylize", "blur", "transform"] as const).map((cat) => (
            <optgroup key={cat} label={cat}>
              {EFFECTS.filter((e) => e.category === cat).map((e) => (
                <option key={e.type} value={e.type}>
                  {e.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      }
    >
      {clip.effects.length === 0 && <div className="text-[11px] text-mute">No effects. Live preview approximates colour effects; paused frames are rendered exactly.</div>}
      {clip.effects.map((fx, i) => {
        const spec = effectSpec(fx.type);
        if (!spec) return null;
        return (
          <div key={fx.id} className={cx("rounded border border-line bg-panel-2", !fx.enabled && "opacity-50")}>
            <div className="flex h-6 items-center gap-1 border-b border-line px-1.5">
              <Sparkle size={11} className="text-warn" />
              <span className="flex-1 text-[11px] font-medium">{spec.label}</span>
              <IconButton size={20} icon={fx.enabled ? <Eye size={11} /> : <EyeOff size={11} />} label={fx.enabled ? "Disable" : "Enable"} onClick={() => cmd("effect.update", { clipId: clip.id, effectId: fx.id, enabled: !fx.enabled }, "Toggle effect")} />
              <IconButton size={20} icon={<ArrowUp size={11} />} label="Move up" disabled={i === 0} onClick={() => cmd("effect.move", { clipId: clip.id, effectId: fx.id, index: i - 1 }, "Reorder effect")} />
              <IconButton size={20} icon={<ArrowDown size={11} />} label="Move down" disabled={i === clip.effects.length - 1} onClick={() => cmd("effect.move", { clipId: clip.id, effectId: fx.id, index: i + 1 }, "Reorder effect")} />
              <IconButton size={20} icon={<Trash2 size={11} />} label="Remove effect" onClick={() => cmd("effect.remove", { clipId: clip.id, effectId: fx.id }, "Remove effect")} />
            </div>
            <div className="space-y-1 p-1.5">
              {spec.params.map((p) => {
                const v = fx.params[p.key];
                const set = (nv: unknown) => cmd("effect.update", { clipId: clip.id, effectId: fx.id, params: { [p.key]: nv } }, `${spec.label}: ${p.label}`);
                return (
                  <Row key={p.key} label={p.label}>
                    {p.kind === "number" && <Slider value={Number(v)} min={p.min} max={p.max} step={p.step} unit={p.unit} onChange={set} />}
                    {p.kind === "enum" && <Select value={String(v)} onChange={set} options={p.options.map((o) => ({ value: o, label: o.replace(/_/g, " ") }))} />}
                    {p.kind === "bool" && <Toggle checked={!!v} onChange={set} />}
                    {p.kind === "color" && <ColorField value={String(v)} onChange={set} />}
                    {p.kind === "asset" && <Select value={String(v)} onChange={set} options={luts.map((l) => ({ value: l.id, label: l.name }))} />}
                  </Row>
                );
              })}
            </div>
          </div>
        );
      })}
    </Section>
  );
}

function KeyframesSection({ clip }: { clip: Clip }) {
  const cmd = useCmd();
  const props = KEYFRAME_PROPERTIES.filter((p) => clip.keyframes[p]?.length);
  if (!props.length) return null;
  return (
    <Section title="Keyframes">
      {props.map((p) => (
        <div key={p}>
          <div className="flex items-center text-[11px] text-dim">
            <span className="flex-1 capitalize">{p}</span>
            <IconButton size={20} icon={<Trash2 size={11} />} label={`Clear ${p} keyframes`} onClick={() => cmd("keyframe.remove", { clipId: clip.id, property: p }, "Clear keyframes")} />
          </div>
          <KeyframeGraph clip={clip} property={p} />
        </div>
      ))}
    </Section>
  );
}

function MultiClipInspector({ clips }: { clips: Clip[] }) {
  const { transaction, setSelection } = useStudio();
  return (
    <div className="space-y-2 p-3">
      <div className="text-[12px]">{clips.length} clips selected</div>
      <Row label="Opacity">
        <Slider value={clips[0]!.opacity} min={0} max={1} step={0.01} onChange={(v) => void transaction("Opacity", clips.map((c) => ({ name: "clip.update", params: { clipId: c.id, props: { opacity: v } } })))} />
      </Row>
      <Button variant="danger" onClick={() => void transaction("Delete clips", [{ name: "clip.remove", params: { clipIds: clips.map((c) => c.id) } }]).then(() => setSelection({ kind: "none" }))}>
        <Trash2 size={12} /> Delete {clips.length} clips
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ track / marker / project

function TrackInspector({ track }: { track: Track }) {
  const cmd = useCmd();
  const upd = (p: Record<string, unknown>, l: string) => cmd("track.update", { trackId: track.id, ...p }, l);
  return (
    <div>
      <Section title="Track">
        <Row label="Name">
          <TextField value={track.name} onCommit={(v) => upd({ name: v }, "Rename track")} />
        </Row>
        <Row label="Kind">
          <span className="text-[11px] capitalize">{track.kind}</span>
        </Row>
        <Row label="Role">
          <Select value={track.role} onChange={(v) => upd({ role: v }, "Track role")} options={["general", "music", "sfx", "dialogue"].map((r) => ({ value: r, label: r }))} />
        </Row>
        <Row label="Gain">
          <Slider value={track.volumeDb} min={-60} max={12} step={0.5} unit="dB" onChange={(v) => upd({ volumeDb: v }, "Track gain")} />
        </Row>
        <Row label="Flags">
          <Toggle checked={track.muted} onChange={(v) => upd({ muted: v }, "Mute")} label="Mute" />
          <Toggle checked={track.solo} onChange={(v) => upd({ solo: v }, "Solo")} label="Solo" />
        </Row>
        <Row label="">
          <Toggle checked={track.locked} onChange={(v) => upd({ locked: v }, "Lock")} label="Lock" />
          {track.kind !== "audio" && <Toggle checked={track.hidden} onChange={(v) => upd({ hidden: v }, "Hide")} label="Hide" />}
        </Row>
        <Button variant="danger" onClick={() => track.clips.length === 0 || window.confirm(`Delete "${track.name}" and its ${track.clips.length} clips?`) ? cmd("track.remove", { trackId: track.id }, "Delete track") : undefined}>
          <Trash2 size={12} /> Delete track
        </Button>
      </Section>
    </div>
  );
}

function MarkerInspector({ markerId }: { markerId: string }) {
  const project = useStudio((s) => s.session.project)!;
  const m = project.markers.find((x) => x.id === markerId)!;
  const cmd = useCmd();
  return (
    <Section title="Marker">
      <Row label="Frame">
        <NumberField value={m.frame} min={0} step={1} unit="f" onChange={(v) => cmd("marker.update", { markerId, frame: v }, "Move marker")} />
      </Row>
      <Row label="Label">
        <TextField value={m.label} onCommit={(v) => cmd("marker.update", { markerId, label: v }, "Label marker")} />
      </Row>
      <Row label="Kind">
        <Select value={m.kind} onChange={(v) => cmd("marker.update", { markerId, kind: v }, "Marker kind")} options={(["cue", "beat", "downbeat", "section", "onset"] as const).map((k) => ({ value: k, label: k }))} />
      </Row>
      <div className="text-[10px] text-mute">Source: {m.source}. Beat markers from analysis are estimates — move or delete freely.</div>
      <div className="flex gap-1">
        <Button variant="danger" onClick={() => cmd("marker.remove", { markerIds: [markerId] }, "Delete marker")}>
          <Trash2 size={12} /> Delete
        </Button>
        {m.source === "analysis" && <Button onClick={() => cmd("marker.remove", { kinds: ["beat", "downbeat", "onset"] }, "Clear beat markers")}>Clear all beats</Button>}
      </div>
    </Section>
  );
}

function ProjectInspector({ project }: { project: Project }) {
  const cmd = useCmd();
  const fps = fpsValue(project.settings.fps);
  const presets = [
    { value: "1080x1920", label: "Vertical 9:16 1080×1920" },
    { value: "1080x1080", label: "Square 1:1 1080×1080" },
    { value: "1920x1080", label: "Landscape 16:9 1920×1080" },
    { value: "3840x2160", label: "Landscape 4K" },
    { value: "2160x3840", label: "Vertical 4K" },
  ];
  const cur = `${project.settings.width}x${project.settings.height}`;
  return (
    <div>
      <Section title="Project">
        <Row label="Name">
          <TextField value={project.name} onCommit={(v) => v && cmd("project.rename", { name: v }, "Rename project")} />
        </Row>
        <Row label="Format">
          <Select
            value={presets.some((p) => p.value === cur) ? cur : "custom"}
            onChange={(v) => {
              const [w, h] = v.split("x").map(Number);
              cmd("project.setSettings", { width: w, height: h }, "Project format");
            }}
            options={[...presets, ...(presets.some((p) => p.value === cur) ? [] : [{ value: "custom", label: `Custom ${cur}` }])]}
          />
        </Row>
        <Row label="Frame rate">
          <Select
            value={String(fps)}
            onChange={(v) => window.confirm("Changing the frame rate re-times every clip, keyframe and marker. Continue?") && cmd("project.setSettings", { fps: { num: Number(v), den: 1 } }, "Frame rate")}
            options={["24", "25", "30", "50", "60"].map((f) => ({ value: f, label: `${f} fps` })).concat(["24", "25", "30", "50", "60"].includes(String(fps)) ? [] : [{ value: String(fps), label: `${fps.toFixed(3)} fps` }])}
          />
        </Row>
        <Row label="Background">
          <ColorField value={project.settings.background} onChange={(v) => cmd("project.setSettings", { background: v }, "Background")} />
        </Row>
      </Section>
      <Section title="Delivery">
        <Row label="Codec">
          <Select value={project.export.codec} onChange={(v) => cmd("project.setExport", { codec: v }, "Export codec")} options={[{ value: "h264", label: "H.264 MP4" }, { value: "h265", label: "H.265 MP4" }, { value: "prores", label: "ProRes 422 HQ MOV" }]} />
        </Row>
        <Row label="Quality (CRF)">
          <Slider value={project.export.crf} min={10} max={30} step={1} onChange={(v) => cmd("project.setExport", { crf: v }, "Export quality")} />
        </Row>
        <Row label="Encoder">
          <Select value={project.export.encoderPreset} onChange={(v) => cmd("project.setExport", { encoderPreset: v }, "Encoder preset")} options={(["veryfast", "fast", "medium", "slow"] as const).map((p) => ({ value: p, label: p }))} />
        </Row>
        <Row label="Audio">
          <Select value={String(project.export.audioBitrateK)} onChange={(v) => cmd("project.setExport", { audioBitrateK: Number(v) }, "Audio bitrate")} options={["128", "192", "256", "320"].map((b) => ({ value: b, label: `${b} kbps AAC` }))} />
        </Row>
      </Section>
      <Section title="Stats" defaultOpen={false}>
        <div className="space-y-0.5 text-[11px] text-dim">
          <div>{project.assets.length} assets · {project.tracks.length} tracks · {project.tracks.reduce((n, t) => n + t.clips.length, 0)} clips</div>
          <div>{project.scenes.length} 3D scenes · {project.markers.length} markers</div>
          <div>Created {new Date(project.createdAt).toLocaleString()}</div>
        </div>
      </Section>
    </div>
  );
}

// ------------------------------------------------------------------ 3D scenes

const VEC_LABELS = ["X", "Y", "Z"];

function Vec3Row({ label, value, step, unit, onChange }: { label: string; value: [number, number, number]; step: number; unit?: string; onChange: (v: [number, number, number]) => void }) {
  return (
    <Row label={label}>
      {value.map((v, i) => (
        <NumberField key={VEC_LABELS[i]} value={v} step={step} unit={i === 2 ? unit : undefined} precision={2} onChange={(nv) => onChange(value.map((x, j) => (j === i ? nv : x)) as [number, number, number])} />
      ))}
    </Row>
  );
}

function SceneInspector({ project, scene, objectId }: { project: Project; scene: Scene; objectId?: string }) {
  const cmd = useCmd();
  const { setSelection, call } = useStudio();
  const fps = fpsValue(project.settings.fps);
  const obj = scene.objects.find((o) => o.id === objectId);
  const [preview, setPreview] = useState<{ url: string; frame: number } | null>(null);
  const [previewFrame, setPreviewFrame] = useState(0);
  const [rendering, setRendering] = useState(false);
  const upd = (p: Record<string, unknown>, l: string) => cmd("scene.update", { sceneId: scene.id, ...p }, l);
  const renderPreview = async () => {
    setRendering(true);
    try {
      const f = Math.min(previewFrame, scene.durationFrames - 1) + 1;
      const r = await call<{ dir: string }>("render.scene", { sceneId: scene.id, quality: "draft", scale: 0.35, frames: [f] });
      setPreview({ url: engine.fileUrl(`${r.dir}/frame_${String(f).padStart(5, "0")}.png`, Date.now())!, frame: previewFrame });
    } catch {
      /* toast already shown */
    } finally {
      setRendering(false);
    }
  };
  const addObject = (kind: SceneObject["kind"]) => {
    const base = { name: kind === "light" ? "Light" : kind === "camera" ? "Camera" : kind === "text" ? "Text" : kind === "particles" ? "Particles" : "Cube" };
    const object =
      kind === "text"
        ? { ...base, kind, rotation: [90, 0, 0], text: { body: "TEXT", size: 1, extrude: 0.15, bevel: 0.02, align: "center", letterSpacing: 1 }, material: { preset: "chrome", baseColor: "#e8e8f0", metallic: 1, roughness: 0.1, emissionColor: "#000000", emissionStrength: 0, transmission: 0 } }
        : kind === "camera"
          ? { ...base, kind, location: [0, -10, 1], rotation: [85, 0, 0] }
          : kind === "light"
            ? { ...base, kind, location: [3, -3, 4], rotation: [45, 0, 45] }
            : { ...base, kind, ...(kind === "mesh" ? { material: { preset: "custom", baseColor: "#cccccc", metallic: 0, roughness: 0.4, emissionColor: "#000000", emissionStrength: 0, transmission: 0 } } : {}) };
    void useStudio
      .getState()
      .dispatch("scene.addObject", { sceneId: scene.id, object: object as never }, `Add ${kind}`)
      .then((r) => setSelection({ kind: "sceneObject", sceneId: scene.id, id: (r as { objectId: string }).objectId }))
      .catch(() => {});
  };
  return (
    <div>
      <Section title="Scene">
        <Row label="Name">
          <TextField value={scene.name} onCommit={(v) => upd({ name: v }, "Rename scene")} />
        </Row>
        <Row label="Duration">
          <NumberField value={scene.durationFrames} min={1} step={1} unit="f" onChange={(v) => upd({ durationFrames: v }, "Scene duration")} />
          <span className="tabular w-12 text-right text-[10px] text-mute">{(scene.durationFrames / fps).toFixed(1)}s</span>
        </Row>
        <Row label="Camera">
          <Select value={scene.activeCameraId ?? ""} onChange={(v) => upd({ activeCameraId: v }, "Active camera")} options={scene.objects.filter((o) => o.kind === "camera").map((o) => ({ value: o.id, label: o.name }))} />
        </Row>
      </Section>
      <Section title="Blender preview">
        <div className="checker relative flex aspect-video items-center justify-center overflow-hidden rounded border border-line">
          {preview ? <img src={preview.url} alt="" className="h-full w-full object-contain" /> : <span className="text-[10px] text-mute">Render a draft frame to see the scene</span>}
          {rendering && <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-[11px]">Blender rendering…</span>}
        </div>
        <Row label="Frame">
          <NumberField value={previewFrame} min={0} max={scene.durationFrames - 1} step={1} unit="f" onChange={setPreviewFrame} />
          <Button onClick={() => void renderPreview()} disabled={rendering}>
            Render
          </Button>
        </Row>
        <div className="text-[10px] text-mute">Draft quality (≈35% resolution, reduced samples). Final export renders at full quality.</div>
      </Section>
      <Section title={`Objects (${scene.objects.length})`} right={<div className="flex">
        <IconButton size={20} icon={<Shapes size={11} />} label="Add mesh" onClick={() => addObject("mesh")} />
        <IconButton size={20} icon={<Type size={11} />} label="Add 3D text" onClick={() => addObject("text")} />
        <IconButton size={20} icon={<Lightbulb size={11} />} label="Add light" onClick={() => addObject("light")} />
        <IconButton size={20} icon={<Camera size={11} />} label="Add camera" onClick={() => addObject("camera")} />
        <IconButton size={20} icon={<Sparkle size={11} />} label="Add particles" onClick={() => addObject("particles")} />
      </div>}>
        <div className="max-h-48 overflow-auto rounded border border-line">
          {scene.objects.map((o) => (
            <div
              key={o.id}
              onClick={() => setSelection({ kind: "sceneObject", sceneId: scene.id, id: o.id })}
              className={cx("flex h-6 cursor-pointer items-center gap-1.5 px-1.5 text-[11px]", o.id === objectId ? "bg-accent/15 text-fg" : "text-dim hover:bg-hover")}
            >
              <span className="text-mute">{o.kind === "camera" ? <Camera size={11} /> : o.kind === "light" ? <Lightbulb size={11} /> : o.kind === "text" ? <Type size={11} /> : o.kind === "particles" ? <Sparkle size={11} /> : <Shapes size={11} />}</span>
              <span className="flex-1 truncate">{o.name}</span>
              {o.animation.length > 0 && <Diamond size={9} className="text-warn" />}
              {o.id === scene.activeCameraId && <span className="text-[9px] text-accent-2">active</span>}
            </div>
          ))}
        </div>
      </Section>
      {obj && <SceneObjectInspector scene={scene} obj={obj} />}
      <Section title="Render" defaultOpen={!obj}>
        <Row label="Engine">
          <Select value={scene.render.engine} onChange={(v) => upd({ render: { engine: v } }, "Render engine")} options={[{ value: "eevee", label: "EEVEE (fast)" }, { value: "cycles", label: "Cycles (path traced)" }, { value: "workbench", label: "Workbench" }]} />
        </Row>
        <Row label="Samples">
          <NumberField value={scene.render.samples} min={1} max={4096} step={1} onChange={(v) => upd({ render: { samples: v } }, "Samples")} />
        </Row>
        <Row label="Motion blur">
          <Toggle checked={scene.render.motionBlur} onChange={(v) => upd({ render: { motionBlur: v } }, "Motion blur")} />
          <NumberField value={scene.render.shutter} min={0.01} max={2} step={0.05} onChange={(v) => upd({ render: { shutter: v } }, "Shutter")} />
        </Row>
        <Row label="Bloom">
          <Toggle checked={scene.render.bloom} onChange={(v) => upd({ render: { bloom: v } }, "Bloom")} />
        </Row>
        <Row label="Transparent">
          <Toggle checked={scene.render.transparent} onChange={(v) => upd({ render: { transparent: v } }, "Transparent background")} label="Alpha background" />
        </Row>
        {scene.render.engine === "cycles" && (
          <Row label="Denoise">
            <Toggle checked={scene.render.denoise} onChange={(v) => upd({ render: { denoise: v } }, "Denoise")} />
          </Row>
        )}
        <Row label="View">
          <Select value={scene.render.viewTransform} onChange={(v) => upd({ render: { viewTransform: v } }, "View transform")} options={["AgX", "Filmic", "Standard"].map((v) => ({ value: v, label: v }))} />
          <Select value={scene.render.look} onChange={(v) => upd({ render: { look: v } }, "Look")} options={["None", "Punchy", "High Contrast", "Base Contrast", "Medium Contrast"].map((v) => ({ value: v, label: v }))} />
        </Row>
      </Section>
      <Section title="World" defaultOpen={!obj}>
        <Row label="Colour">
          <ColorField value={scene.world.color} onChange={(v) => upd({ world: { color: v } }, "World colour")} />
        </Row>
        <Row label="Strength">
          <Slider value={scene.world.strength} min={0} max={5} step={0.05} onChange={(v) => upd({ world: { strength: v } }, "World strength")} />
        </Row>
        <Row label="Fog">
          <Slider value={scene.world.fog} min={0} max={1} step={0.01} onChange={(v) => upd({ world: { fog: v } }, "Fog")} />
        </Row>
        <Row label="Reflections" title="Studio light band seen only in reflections (makes chrome read well). Fog absorbs it.">
          <Slider value={scene.world.reflections} min={0} max={10} step={0.1} onChange={(v) => upd({ world: { reflections: v } }, "Reflections")} />
        </Row>
      </Section>
      <Section title="Danger zone" defaultOpen={false}>
        <Button
          variant="danger"
          onClick={() => {
            const used = project.tracks.some((t) => t.clips.some((c) => c.type === "scene" && c.sceneId === scene.id));
            if (used && !window.confirm("This scene is on the timeline. Delete it and its clips?")) return;
            void useStudio.getState().dispatch("scene.remove", { sceneId: scene.id, force: used }, "Delete scene").then(() => setSelection({ kind: "none" }));
          }}
        >
          <Trash2 size={12} /> Delete scene
        </Button>
      </Section>
    </div>
  );
}

function SceneObjectInspector({ scene, obj }: { scene: Scene; obj: SceneObject }) {
  const cmd = useCmd();
  const { setSelection } = useStudio();
  const [keyFrame, setKeyFrame] = useState(0);
  const upd = (patch: Record<string, unknown>, l: string) => cmd("scene.updateObject", { sceneId: scene.id, objectId: obj.id, patch: patch as never }, l);
  const animOf = (prop: string) => obj.animation.find((a) => a.property === prop);
  const setKey = (prop: "location" | "rotation" | "scale" | "focalLength" | "energy" | "focusDistance") => {
    const cur =
      prop === "location" ? obj.location : prop === "rotation" ? obj.rotation : prop === "scale" ? obj.scale : prop === "focalLength" ? [obj.camera?.focalLength ?? 50] : prop === "focusDistance" ? [obj.camera?.focusDistance ?? 5] : [obj.light?.energy ?? 500];
    const existing = animOf(prop)?.keyframes.filter((k) => k.frame !== keyFrame) ?? [];
    cmd("scene.animate", { sceneId: scene.id, objectId: obj.id, property: prop, keyframes: [...existing, { frame: keyFrame, value: [...cur], easing: "easeInOut" }] }, `Key ${prop}`);
  };
  const m = obj.material;
  return (
    <>
      <Section title={`${obj.kind} · ${obj.name}`}>
        <Row label="Name">
          <TextField value={obj.name} onCommit={(v) => upd({ name: v }, "Rename object")} />
        </Row>
        <Row label="Visible">
          <Toggle checked={obj.visible} onChange={(v) => upd({ visible: v }, "Visibility")} />
        </Row>
        <Vec3Row label="Location" value={obj.location} step={0.05} onChange={(v) => upd({ location: v }, "Move object")} />
        <Vec3Row label="Rotation" value={obj.rotation} step={1} unit="°" onChange={(v) => upd({ rotation: v }, "Rotate object")} />
        <Vec3Row label="Scale" value={obj.scale} step={0.05} onChange={(v) => upd({ scale: v }, "Scale object")} />
        {obj.mesh && (
          <Row label="Primitive">
            <Select value={obj.mesh.primitive} onChange={(v) => upd({ mesh: { primitive: v } }, "Primitive")} options={MESH_PRIMITIVES.map((p) => ({ value: p, label: p }))} />
            <NumberField value={obj.mesh.size} min={0.01} step={0.1} onChange={(v) => upd({ mesh: { size: v } }, "Size")} />
          </Row>
        )}
        {obj.text && (
          <>
            <TextField value={obj.text.body} onCommit={(v) => v && upd({ text: { body: v } }, "3D text")} />
            <Row label="Size / depth">
              <NumberField value={obj.text.size} min={0.05} step={0.05} onChange={(v) => upd({ text: { size: v } }, "Text size")} />
              <NumberField value={obj.text.extrude} min={0} max={5} step={0.01} onChange={(v) => upd({ text: { extrude: v } }, "Extrude")} />
            </Row>
            <Row label="Bevel">
              <NumberField value={obj.text.bevel} min={0} max={1} step={0.005} onChange={(v) => upd({ text: { bevel: v } }, "Bevel")} />
            </Row>
          </>
        )}
        {obj.camera && (
          <>
            <Row label="Focal length">
              <NumberField value={obj.camera.focalLength} min={5} max={500} step={1} unit="mm" onChange={(v) => upd({ camera: { focalLength: v } }, "Focal length")} />
            </Row>
            <Row label="Depth of field">
              <Toggle checked={obj.camera.dof} onChange={(v) => upd({ camera: { dof: v } }, "DOF")} />
              <NumberField value={obj.camera.fStop} min={0.5} max={64} step={0.1} unit="f/" onChange={(v) => upd({ camera: { fStop: v } }, "f-stop")} />
            </Row>
            <Row label="Focus dist.">
              <NumberField value={obj.camera.focusDistance} min={0.01} step={0.1} unit="m" onChange={(v) => upd({ camera: { focusDistance: v } }, "Focus distance")} />
            </Row>
            <Row label="Look at">
              <Select value={obj.camera.trackTargetId ?? ""} onChange={(v) => upd({ camera: { trackTargetId: v || undefined } }, "Camera target")} options={[{ value: "", label: "None (use rotation)" }, ...scene.objects.filter((o) => o.id !== obj.id && o.kind !== "camera").map((o) => ({ value: o.id, label: o.name }))]} />
            </Row>
            {scene.activeCameraId !== obj.id && <Button onClick={() => cmd("scene.update", { sceneId: scene.id, activeCameraId: obj.id }, "Active camera")}>Make active camera</Button>}
          </>
        )}
        {obj.light && (
          <>
            <Row label="Type">
              <Select value={obj.light.type} onChange={(v) => upd({ light: { type: v } }, "Light type")} options={["point", "sun", "area", "spot"].map((t) => ({ value: t, label: t }))} />
            </Row>
            <Row label="Colour">
              <ColorField value={obj.light.color} onChange={(v) => upd({ light: { color: v } }, "Light colour")} />
            </Row>
            <Row label="Power">
              <NumberField value={obj.light.energy} min={0} step={10} unit="W" onChange={(v) => upd({ light: { energy: v } }, "Light power")} />
            </Row>
            <Row label="Size">
              <NumberField value={obj.light.size} min={0} step={0.1} onChange={(v) => upd({ light: { size: v } }, "Light size")} />
            </Row>
          </>
        )}
        {obj.particles && (
          <>
            <Row label="Count">
              <NumberField value={obj.particles.count} min={1} max={5000} step={10} onChange={(v) => upd({ particles: { count: v } }, "Particle count")} />
            </Row>
            <Row label="Size">
              <NumberField value={obj.particles.size} min={0.001} step={0.005} onChange={(v) => upd({ particles: { size: v } }, "Particle size")} />
            </Row>
            <Row label="Colour / glow">
              <ColorField value={obj.particles.color} onChange={(v) => upd({ particles: { color: v } }, "Particle colour")} />
              <NumberField value={obj.particles.emission} min={0} max={100} step={0.5} onChange={(v) => upd({ particles: { emission: v } }, "Particle glow")} />
            </Row>
            <Row label="Seed">
              <NumberField value={obj.particles.seed} step={1} onChange={(v) => upd({ particles: { seed: v } }, "Seed")} />
            </Row>
          </>
        )}
        <Button
          variant="danger"
          onClick={() => {
            cmd("scene.removeObject", { sceneId: scene.id, objectId: obj.id }, "Delete object");
            setSelection({ kind: "scene", id: scene.id });
          }}
        >
          <Trash2 size={12} /> Delete object
        </Button>
      </Section>
      {m && (obj.kind === "mesh" || obj.kind === "text" || obj.kind === "model") && (
        <Section title="Material">
          <Row label="Preset">
            <Select value={m.preset} onChange={(v) => upd({ material: { preset: v } }, "Material preset")} options={MATERIAL_PRESETS.map((p) => ({ value: p, label: p }))} />
          </Row>
          <Row label="Base colour">
            <ColorField value={m.baseColor} onChange={(v) => upd({ material: { baseColor: v } }, "Base colour")} />
          </Row>
          {m.preset === "custom" && (
            <>
              <Row label="Metallic">
                <Slider value={m.metallic} min={0} max={1} step={0.01} onChange={(v) => upd({ material: { metallic: v } }, "Metallic")} />
              </Row>
              <Row label="Roughness">
                <Slider value={m.roughness} min={0} max={1} step={0.01} onChange={(v) => upd({ material: { roughness: v } }, "Roughness")} />
              </Row>
              <Row label="Transmission">
                <Slider value={m.transmission} min={0} max={1} step={0.01} onChange={(v) => upd({ material: { transmission: v } }, "Transmission")} />
              </Row>
            </>
          )}
          <Row label="Emission">
            <ColorField value={m.emissionColor} onChange={(v) => upd({ material: { emissionColor: v } }, "Emission colour")} />
            <NumberField value={m.emissionStrength} min={0} max={100} step={0.5} onChange={(v) => upd({ material: { emissionStrength: v } }, "Emission strength")} />
          </Row>
        </Section>
      )}
      <Section title="Animation">
        <Row label="Key frame">
          <NumberField value={keyFrame} min={0} max={scene.durationFrames} step={1} unit="f" onChange={setKeyFrame} />
        </Row>
        <div className="text-[10px] text-mute">Sets a keyframe with the object's current values at this scene frame.</div>
        <div className="flex flex-wrap gap-1">
          {(["location", "rotation", "scale", ...(obj.camera ? (["focalLength", "focusDistance"] as const) : []), ...(obj.light ? (["energy"] as const) : [])] as const).map((p) => (
            <Button key={p} onClick={() => setKey(p)}>
              <Plus size={11} /> {p}
            </Button>
          ))}
        </div>
        {obj.animation.map((a) => (
          <div key={a.property} className="text-[11px]">
            <div className="flex items-center text-dim">
              <span className="flex-1">{a.property}</span>
              <IconButton size={20} icon={<Trash2 size={11} />} label={`Clear ${a.property} animation`} onClick={() => cmd("scene.animate", { sceneId: scene.id, objectId: obj.id, property: a.property, keyframes: [] }, "Clear animation")} />
            </div>
            <div className="flex flex-wrap gap-1">
              {a.keyframes.map((k) => (
                <span key={k.frame} className="tabular rounded bg-raised px-1 py-0.5 font-mono text-[10px]">
                  {k.frame}f [{k.value.map((v) => Math.round(v * 100) / 100).join(", ")}]
                </span>
              ))}
            </div>
          </div>
        ))}
      </Section>
    </>
  );
}
