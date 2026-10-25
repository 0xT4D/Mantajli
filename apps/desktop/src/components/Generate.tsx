import { Gauge, Mic, Music, Plus } from "lucide-react";
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

/** The engine's first voice in the UI language (English otherwise), else its first voice. */
function defaultVoice(voices: { id: string; name: string; language?: string }[]): string {
  const lang = (navigator.language || "en-US").toLowerCase();
  const pick = (l: string) => voices.find((v) => (v.language ?? v.id).toLowerCase() === l) ?? voices.find((v) => (v.language ?? v.id).toLowerCase().startsWith(l.split("-")[0]!));
  return (pick(lang) ?? pick("en-us") ?? voices[0])?.id ?? "";
}

type Provider = { id: string; label: string; kind: "local" | "cloud"; available: boolean; reason?: string; voices: { id: string; name: string; language?: string }[] };
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
      // Pre-select a local engine only; a cloud engine must be picked by the user.
      const first = list.find((x) => x.available && x.kind === "local");
      if (first) {
        setProvider(first.id);
        setVoice(defaultVoice(first.voices));
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
              setVoice(defaultVoice(providers?.find((x) => x.id === v)?.voices ?? []));
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

type Suggestion = { index: number; kind: string; anchorFrame: number; gainDb: number; reason: string; trigger: string };
/** Meter values are null when not measurable (NaN over JSON), e.g. no 3 s window in a short mix. */
const db = (v: number | null, unit: string) => (v === null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)} ${unit}`);
type Meter = { integratedLufs: number | null; loudnessRangeLu: number | null; truePeakDb: number | null; maxShortTermLufs: number | null; hotSpans: { seconds: string; peakDb: number }[]; warnings: string[]; exportLoudnessTarget: number | null };

/** Context-aware sound design: review suggested effects, place the chosen ones, and measure the mix. */
export function SoundDesignDialog() {
  const { session, setDialog, call, toast } = useStudio();
  const p = session.project!;
  const fps = fpsValue(p.settings.fps);
  const [intensity, setIntensity] = useState<"subtle" | "normal" | "bold">("normal");
  const [list, setList] = useState<Suggestion[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [meter, setMeter] = useState<Meter | null>(null);
  const [busy, setBusy] = useState("");
  const tool = async <T,>(name: string, input: Record<string, unknown>) => {
    const r = await call<ToolResult<T>>("tools.call", { name, input }).catch(() => null);
    if (!r?.ok) toast("error", r?.error?.message ?? `${name} failed`);
    return r?.ok ? r.data : undefined;
  };
  const suggest = async (level = intensity) => {
    setBusy("suggest");
    const d = await tool<{ suggestions: Suggestion[] }>("sfx_suggest", { intensity: level });
    setBusy("");
    if (d) {
      setList(d.suggestions);
      setPicked(new Set(d.suggestions.map((x) => x.index)));
    }
  };
  useEffect(() => void suggest(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const apply = async () => {
    setBusy("apply");
    const d = await tool<{ applied: number }>("sfx_suggest", { apply: true, intensity, only: [...picked] });
    setBusy("");
    if (d) {
      toast("ok", `Placed ${d.applied} sound effect(s) on SFX tracks (undo with Ctrl+Z)`);
      void suggest();
    }
  };
  const measure = async () => {
    setBusy("meter");
    const d = await tool<Meter>("audio_meter", {});
    setBusy("");
    if (d) setMeter(d);
  };
  const fmt = (f: number) => `${Math.floor(f / fps / 60)}:${(f / fps % 60).toFixed(1).padStart(4, "0")}`;
  return (
    <Dialog
      title="Sound design"
      width={640}
      onClose={() => setDialog(null)}
      footer={
        <>
          <Button onClick={() => setDialog(null)}>Close</Button>
          <Button disabled={!!busy} onClick={() => void measure()}>
            <Gauge size={13} /> {busy === "meter" ? "Measuring…" : "Measure mix"}
          </Button>
          <Button variant="primary" disabled={!!busy || !picked.size} onClick={() => void apply()}>
            <Plus size={13} /> {busy === "apply" ? "Placing…" : `Place ${picked.size} effect(s)`}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Row label="Intensity">
          <Select
            value={intensity}
            onChange={(v) => {
              setIntensity(v);
              void suggest(v);
            }}
            options={[
              { value: "subtle", label: "Subtle (−4 dB)" },
              { value: "normal", label: "Normal" },
              { value: "bold", label: "Bold (+3 dB)" },
            ]}
          />
        </Row>
        <div className="max-h-64 space-y-0.5 overflow-auto rounded border border-line p-1">
          {list === null && <div className="p-2 text-[11px] text-mute">Reading the timeline…</div>}
          {list?.length === 0 && <div className="p-2 text-[11px] text-mute">Nothing to add: no transitions, drops or titles without an effect yet.</div>}
          {list?.map((x) => (
            <label key={x.index} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-0.5 text-[11px] hover:bg-hover">
              <input
                type="checkbox"
                checked={picked.has(x.index)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(x.index);
                  else next.delete(x.index);
                  setPicked(next);
                }}
              />
              <span className="tabular w-12 shrink-0 text-mute">{fmt(x.anchorFrame)}</span>
              <span className="w-20 shrink-0 font-medium">{x.kind}</span>
              <span className="tabular w-12 shrink-0 text-mute">{x.gainDb} dB</span>
              <span className="truncate text-dim">{x.reason}</span>
            </label>
          ))}
        </div>
        {meter && (
          <div className="space-y-1 rounded border border-line p-2 text-[11px]">
            <div className="flex flex-wrap gap-3">
              <span>Integrated <b>{db(meter.integratedLufs, "LUFS")}</b></span>
              <span>True peak <b className={(meter.truePeakDb ?? -99) > -0.5 ? "text-warn" : ""}>{db(meter.truePeakDb, "dBTP")}</b></span>
              <span>Range {db(meter.loudnessRangeLu, "LU")}</span>
              <span>Loudest 3 s {db(meter.maxShortTermLufs, "LUFS")}</span>
              <span className="text-mute">export target: {meter.exportLoudnessTarget ?? "as mixed"}</span>
            </div>
            {meter.hotSpans.length > 0 && <div className="text-warn">Above −1 dBTP at {meter.hotSpans.map((h) => `${h.seconds}s`).join(", ")}</div>}
            {meter.warnings.map((w) => (
              <div key={w} className="text-warn">
                {w}
              </div>
            ))}
            {meter.warnings.length === 0 && <div className="text-ok">No problems found.</div>}
          </div>
        )}
        <div className="text-[10px] text-mute">
          Effects are synthesized (original, free to use) and land on their moment: whooshes peak at whip pans, risers end on the cut or the drop,
          hits and impacts start there. One effect per moment, at most ~0.6 per second, quieter under dialogue. The meter renders the mix as it will be
          exported (gains, ducking, loudness target, limiter).
        </div>
      </div>
    </Dialog>
  );
}
