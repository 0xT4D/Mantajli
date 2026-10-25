import { Mic, Music, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { CAPTION_STYLES, fpsValue, MUSIC_MOOD_LABELS, MUSIC_MOODS, MUSIC_STYLE_SPECS, MUSIC_STYLES, projectDuration, type CaptionStyle, type MusicMood, type MusicStyle } from "@mantagli/core";
import { engine } from "../engine/client";
import { useStudio } from "../store/studio";
import { Button, Dialog, NumberField, Row, Select, TextField } from "./ui";

type ToolResult<T> = { ok: boolean; data?: T; error?: { message: string } };

/**
 * Compose an original track with the procedural music generator, listen to it, then place it on
 * a music track at the playhead with its exact beat, downbeat and section markers.
 */
export function MusicDialog() {
  const { session, setDialog, call, playhead, toast, setSelection } = useStudio();
  const p = session.project!;
  const fps = fpsValue(p.settings.fps);
  const timeline = projectDuration(p);
  const [style, setStyle] = useState<MusicStyle>("synthwave");
  const [mood, setMood] = useState<MusicMood>("dark");
  const [bpm, setBpm] = useState(MUSIC_STYLE_SPECS.synthwave.bpm);
  const [duration, setDuration] = useState(Math.round(timeline > fps * 4 ? timeline / fps : 30));
  const [seed, setSeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ url: string; sections: { label: string; frame: number; bars: number }[]; key: string } | null>(null);
  const input = { style, mood, bpm, duration, seed };
  const key = JSON.stringify(input);

  const run = async (place: boolean) => {
    setBusy(true);
    const r = await call<ToolResult<{ assetId: string; clipId?: string; sections: { label: string; frame: number; bars: number }[] }>>("tools.call", {
      name: "music_generate",
      input: { ...input, place, start: playhead },
    }).catch(() => null);
    setBusy(false);
    if (!r?.ok || !r.data) return toast("error", r?.error?.message ?? "Music generation failed");
    if (!place) {
      const asset = useStudio.getState().session.project?.assets.find((a) => a.id === r.data!.assetId);
      if (asset) setPreview({ url: engine.fileUrl(asset.path, Date.now())!, sections: r.data.sections, key });
      return;
    }
    toast("ok", `Music placed with ${r.data.sections.length} sections as markers (undo with Ctrl+Z)`);
    if (r.data.clipId) setSelection({ kind: "clips", ids: [r.data.clipId] });
    setDialog(null);
  };

  return (
    <Dialog
      title="Generate music"
      width={560}
      onClose={() => setDialog(null)}
      footer={
        <>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
          <Button disabled={busy} onClick={() => void run(false)}>
            <Music size={13} /> {busy ? "Composing…" : "Compose & preview"}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void run(true)}>
            <Plus size={13} /> Add at playhead
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Row label="Style">
          <Select
            value={style}
            onChange={(v) => {
              setStyle(v);
              setBpm(MUSIC_STYLE_SPECS[v].bpm);
            }}
            options={MUSIC_STYLES.map((s) => ({ value: s, label: MUSIC_STYLE_SPECS[s].label }))}
          />
        </Row>
        <div className="pl-24 text-[10px] text-mute">{MUSIC_STYLE_SPECS[style].description}</div>
        <Row label="Mood">
          <Select value={mood} onChange={setMood} options={MUSIC_MOODS.map((m) => ({ value: m, label: MUSIC_MOOD_LABELS[m] }))} />
        </Row>
        <Row label="Tempo / length">
          <NumberField value={bpm} min={60} max={180} step={1} unit="BPM" onChange={setBpm} />
          <NumberField value={duration} min={4} max={600} step={1} unit="s" onChange={setDuration} />
        </Row>
        <Row label="Variation" title="Seed: another number gives another key and fills with the same structure">
          <NumberField value={seed} min={0} max={1000000} step={1} onChange={setSeed} />
        </Row>
        {preview && (
          <div className="space-y-1 rounded border border-line p-2">
            {preview.key !== key && <div className="text-[10px] text-warn">Settings changed since this preview — compose again to hear them.</div>}
            <audio src={preview.url} controls className="w-full" />
            <div className="flex flex-wrap gap-1 text-[10px] text-dim">
              {preview.sections.map((s, i) => (
                <span key={i} className="rounded bg-panel-2 px-1.5 py-0.5">
                  {s.label} · {s.bars} bars · {((s.frame - playhead) / fps).toFixed(1)}s
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="text-[10px] text-mute">
          Original music from Mantagli's procedural synthesizer (not a neural model): free to use. Its beat grid and sections are exact, so
          cuts, titles and effects snap to the drops. The structure is planned from the length (intro, build, drop, breakdown, outro).
        </div>
      </div>
    </Dialog>
  );
}

type Provider = { id: string; label: string; kind: "local" | "cloud"; available: boolean; reason?: string; voices: { id: string; name: string }[] };
type SegmentOut = { text: string; start?: number; frames?: number; seconds?: number; path?: string };

/**
 * Voice-over from a script: one segment per paragraph, spoken by a local or cloud TTS engine,
 * placed on a dialogue track from the playhead with captions, and music ducked under it.
 */
export function VoiceDialog() {
  const { session, setDialog, call, playhead, toast, setSelection } = useStudio();
  const p = session.project!;
  const fps = fpsValue(p.settings.fps);
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [provider, setProvider] = useState("");
  const [voice, setVoice] = useState("");
  const [rate, setRate] = useState(1);
  const [style, setStyle] = useState("");
  const [script, setScript] = useState("");
  const [captions, setCaptions] = useState<"none" | CaptionStyle>("clean");
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState<{ kind: "estimate" | "preview"; segments: SegmentOut[] } | null>(null);
  useEffect(() => {
    void call<ToolResult<{ providers: Provider[] }>>("tools.call", { name: "voice_providers", input: {} }).then((r) => {
      const list = r.data?.providers ?? [];
      setProviders(list);
      const first = list.find((x) => x.available);
      if (first) {
        setProvider(first.id);
        setVoice(first.voices[0]?.id ?? "");
      }
    });
  }, [call]);
  const current = providers?.find((x) => x.id === provider);
  const segments = script
    .split(/\n\s*\n/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((text) => ({ text }));
  const input = { segments, provider: provider || undefined, voice: voice || undefined, rate, style: style || undefined, start: playhead, captions: captions !== "none", ...(captions !== "none" ? { captionStyle: captions } : {}) };

  const run = async (mode: "estimate" | "preview" | "place") => {
    if (!segments.length) return;
    setBusy(mode);
    const r = await call<ToolResult<{ segments: SegmentOut[]; endFrame?: number; clipId?: string }>>("tools.call", {
      name: "voice_narrate",
      input: { ...input, dryRun: mode === "estimate", place: mode === "place", ...(mode === "preview" ? { segments: segments.slice(0, 1) } : {}) },
    }).catch(() => null);
    setBusy("");
    if (!r?.ok || !r.data) return toast("error", r?.error?.message ?? "Voice-over failed");
    if (mode !== "place") return setResult({ kind: mode, segments: r.data.segments });
    toast("ok", `Placed ${r.data.segments.length} voice segment(s) (undo with Ctrl+Z)`);
    setSelection({ kind: "clips", ids: (r.data.segments as { clipId?: string }[]).map((s) => s.clipId!).filter(Boolean) });
    setDialog(null);
  };

  return (
    <Dialog
      title="Voice-over"
      width={620}
      onClose={() => setDialog(null)}
      footer={
        <>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
          <Button disabled={!segments.length || !!busy} onClick={() => void run("estimate")}>
            {busy === "estimate" ? "Estimating…" : "Estimate timing"}
          </Button>
          <Button disabled={!segments.length || !!busy || !current?.available} onClick={() => void run("preview")}>
            <Mic size={13} /> {busy === "preview" ? "Speaking…" : "Preview first segment"}
          </Button>
          <Button variant="primary" disabled={!segments.length || !!busy || !current?.available} onClick={() => void run("place")}>
            <Plus size={13} /> {busy === "place" ? "Speaking…" : `Add ${segments.length || ""} at playhead`}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <TextField multiline value={script} onCommit={setScript} placeholder={"Script — one segment per paragraph.\n\nBlank lines separate segments; each can be re-voiced on its own later."} className="min-h-28" />
        <Row label="Engine">
          <Select
            value={provider}
            onChange={(v) => {
              setProvider(v);
              setVoice(providers?.find((x) => x.id === v)?.voices[0]?.id ?? "");
            }}
            options={(providers ?? []).map((x) => ({ value: x.id, label: `${x.label}${x.available ? "" : ` — ${x.reason}`}` }))}
          />
        </Row>
        {current && (
          <Row label="Voice">
            {current.voices.length ? <Select value={voice} onChange={setVoice} options={current.voices.map((v) => ({ value: v.id, label: v.name }))} /> : <TextField value={voice} onCommit={setVoice} placeholder="voice id" />}
          </Row>
        )}
        <Row label="Speed">
          <NumberField value={rate} min={0.5} max={2} step={0.05} unit="×" onChange={setRate} />
          <Select value={captions} onChange={setCaptions} options={[{ value: "none", label: "No captions" }, ...CAPTION_STYLES.map((c) => ({ value: c, label: `Captions: ${c}` }))]} />
        </Row>
        {current?.kind === "cloud" && (
          <Row label="Delivery" title="Direction for engines that take it (OpenAI), e.g. calm documentary narrator">
            <TextField value={style} onCommit={setStyle} placeholder="e.g. cinematic trailer narrator, low and calm" />
          </Row>
        )}
        {result && (
          <div className="space-y-1 rounded border border-line p-2 text-[11px]">
            {result.kind === "preview" && result.segments[0]?.path && <audio src={engine.fileUrl(result.segments[0].path, Date.now())} controls autoPlay className="w-full" />}
            {result.segments.map((s, i) => (
              <div key={i} className="flex gap-2 text-dim">
                <span className="tabular w-24 shrink-0 text-mute">
                  {s.frames !== undefined ? `${((s.start! - playhead) / fps).toFixed(1)}s +${(s.frames / fps).toFixed(1)}s` : `${s.seconds?.toFixed(1)}s`}
                </span>
                <span className="truncate">{s.text}</span>
              </div>
            ))}
            {result.kind === "estimate" && <div className="text-[10px] text-mute">Estimated (~150 words/min × speed); the real length comes from the voice.</div>}
          </div>
        )}
        <div className="text-[10px] text-mute">
          {current?.kind === "cloud"
            ? "Cloud engine: the script text is sent to the provider with your API key (set in the engine's environment)."
            : "Local engine: nothing leaves this computer."}{" "}
          Captions are timed across each segment's real audio by text length (not speech recognition). Music on music tracks is ducked under the voice.
        </div>
      </div>
    </Dialog>
  );
}
