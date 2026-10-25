/**
 * Audio analysis: waveform peaks, tempo, beat tracking, downbeats, transient
 * onsets and song structure (drops, breakdowns, builds).
 *
 * Onset envelope = log-magnitude spectral flux. Tempo = autocorrelation of the
 * envelope with a log-normal prior around 120 BPM. Beats = dynamic-programming
 * beat tracker (Ellis 2007). Sections = novelty of loudness, brightness and
 * onset density (see detectSections). Results are estimates; markers stay
 * editable.
 */

export const ANALYSIS_SR = 11025;
const WIN = 1024;
const HOP = 128;
export const PEAKS_PER_SECOND = 100;

export interface WaveformData {
  peaksPerSecond: number;
  duration: number;
  /** Peak amplitude per bucket, 0–255. */
  peaks: number[];
}

export const SECTION_LABELS = ["intro", "build", "drop", "breakdown", "change", "outro"] as const;
export type SectionLabel = (typeof SECTION_LABELS)[number];

export interface SectionInfo {
  /** Section start, seconds. */
  time: number;
  label: SectionLabel;
  /** Relative loudness of the section (0 = quietest, 1 = loudest). */
  energy: number;
}

export interface BeatResult {
  bpm: number;
  beats: number[];
  strengths: number[];
  downbeats: number[];
  onsets: number[];
  confidence: number;
  sections: SectionInfo[];
}

/** Per-hop features for structure analysis (same hop as the onset envelope). */
export interface StructureFeatures {
  /** RMS of the analysis window. */
  rms: number[];
  /** Share of spectral magnitude above about 1.4 kHz (0-1). */
  bright: number[];
  /** Spectral flux (onset envelope). */
  flux: number[];
}

/** Incremental waveform + onset-envelope builder fed with PCM chunks. */
export class AudioAccumulator {
  private peaks: number[] = [];
  private bucketMax = 0;
  private bucketCount = 0;
  private readonly bucketSize = Math.round(ANALYSIS_SR / PEAKS_PER_SECOND);
  private ring = new Float32Array(WIN);
  private ringFill = 0;
  private writePos = 0;
  private sinceHop = 0;
  private prevMag: Float32Array | null = null;
  private window = hann(WIN);
  private re = new Float64Array(WIN);
  private im = new Float64Array(WIN);
  readonly envelope: number[] = [];
  readonly rms: number[] = [];
  readonly bright: number[] = [];
  samples = 0;

  constructor(private readonly withOnsets: boolean) {}

  push(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) {
      const s = chunk[i]!;
      const a = Math.abs(s);
      if (a > this.bucketMax) this.bucketMax = a;
      if (++this.bucketCount >= this.bucketSize) {
        this.peaks.push(Math.min(255, Math.round(this.bucketMax * 255)));
        this.bucketMax = 0;
        this.bucketCount = 0;
      }
      if (this.withOnsets) {
        // Circular buffer of the last WIN samples.
        this.ring[this.writePos] = s;
        this.writePos = (this.writePos + 1) % WIN;
        if (this.ringFill < WIN) this.ringFill++;
        if (++this.sinceHop >= HOP && this.ringFill === WIN) {
          this.sinceHop = 0;
          this.frame();
        }
      }
    }
    this.samples += chunk.length;
  }

  private frame(): void {
    for (let i = 0; i < WIN; i++) {
      this.re[i] = this.ring[(this.writePos + i) % WIN]! * this.window[i]!;
      this.im[i] = 0;
    }
    let sq = 0;
    for (let i = 0; i < WIN; i++) sq += this.ring[i]! * this.ring[i]!;
    this.rms.push(Math.sqrt(sq / WIN));
    fft(this.re, this.im);
    const bins = WIN / 2;
    const mag = new Float32Array(bins);
    let lin = 0;
    let high = 0;
    for (let k = 0; k < bins; k++) {
      const m = Math.hypot(this.re[k]!, this.im[k]!);
      mag[k] = Math.log1p(100 * m);
      lin += m;
      if (k >= bins / 4) high += m;
    }
    this.bright.push(lin > 1e-9 ? high / lin : 0);
    let flux = 0;
    if (this.prevMag) for (let k = 1; k < bins; k++) flux += Math.max(0, mag[k]! - this.prevMag[k]!);
    this.prevMag = mag;
    this.envelope.push(flux);
  }

  waveform(): WaveformData {
    const peaks = [...this.peaks];
    if (this.bucketCount > 0) peaks.push(Math.min(255, Math.round(this.bucketMax * 255)));
    return { peaksPerSecond: PEAKS_PER_SECOND, duration: this.samples / ANALYSIS_SR, peaks };
  }
}

export function detectBeats(envelopeRaw: number[], features?: Omit<StructureFeatures, "flux">): BeatResult {
  const fr = ANALYSIS_SR / HOP; // envelope frames per second (~86)
  const n = envelopeRaw.length;
  const empty: BeatResult = { bpm: 0, beats: [], strengths: [], downbeats: [], onsets: [], confidence: 0, sections: [] };
  if (n < fr * 4) return empty;

  // Normalise: subtract local mean, half-wave rectify, unit std.
  const env = new Float64Array(n);
  const half = Math.round(fr * 0.25);
  let acc = 0;
  const pre: number[] = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i]! + envelopeRaw[i]!;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    env[i] = Math.max(0, envelopeRaw[i]! - (pre[b]! - pre[a]!) / (b - a));
    acc += env[i]! * env[i]!;
  }
  const std = Math.sqrt(acc / n) || 1;
  for (let i = 0; i < n; i++) env[i]! /= std;

  // Tempo by autocorrelation in 60–200 BPM with a prior centred on 120 BPM.
  const minLag = Math.floor((60 / 200) * fr);
  const maxLag = Math.ceil((60 / 60) * fr);
  let bestLag = 0;
  let bestScore = -Infinity;
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i]! * env[i - lag]!;
    s /= n - lag;
    const bpm = (60 * fr) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const w = s * prior;
    scores.push(w);
    if (w > bestScore) {
      bestScore = w;
      bestLag = lag;
    }
  }
  // Parabolic refinement of the lag.
  const li = bestLag - minLag;
  let lagF = bestLag;
  if (li > 0 && li < scores.length - 1) {
    const [a, b, c] = [scores[li - 1]!, scores[li]!, scores[li + 1]!];
    const denom = a - 2 * b + c;
    if (denom !== 0) lagF = bestLag + (0.5 * (a - c)) / denom;
  }
  const meanScore = scores.reduce((x, y) => x + y, 0) / scores.length;
  const confidence = Math.max(0, Math.min(1, (bestScore - meanScore) / (bestScore + 1e-9)));
  const period = lagF;

  // Dynamic-programming beat tracking.
  const alpha = 100;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, Math.round(i - 2 * period));
    const hi = Math.max(0, Math.round(i - period / 2));
    let best = 0;
    let arg = -1;
    for (let j = lo; j < hi; j++) {
      const d = Math.log((i - j) / period);
      const v = score[j]! - alpha * d * d;
      if (arg < 0 || v > best) {
        best = v;
        arg = j;
      }
    }
    score[i] = env[i]! + (arg >= 0 ? best : 0);
    back[i] = arg;
  }
  // Start backtracking from the best-scoring frame in the last period.
  let end = n - 1;
  let endScore = -Infinity;
  for (let i = Math.max(0, Math.floor(n - period)); i < n; i++) if (score[i]! > endScore) { endScore = score[i]!; end = i; }
  const beatFrames: number[] = [];
  for (let i = end; i >= 0; i = back[i]!) {
    beatFrames.push(i);
    if (back[i]! < 0) break;
  }
  beatFrames.reverse();
  // Drop leading beats that sit in silence.
  while (beatFrames.length > 1 && env[beatFrames[0]!]! < 0.05) beatFrames.shift();

  const lagSeconds = (f: number) => (f * HOP + WIN / 2) / ANALYSIS_SR;
  const maxEnv = Math.max(1e-9, ...beatFrames.map((f) => env[f]!));
  const beats = beatFrames.map(lagSeconds);
  const strengths = beatFrames.map((f) => Math.round((env[f]! / maxEnv) * 1000) / 1000);

  // Downbeats: assume 4/4 and pick the phase with the most energy.
  let phase = 0;
  let phaseBest = -Infinity;
  for (let ph = 0; ph < 4; ph++) {
    let s = 0;
    for (let i = ph; i < beatFrames.length; i += 4) s += env[beatFrames[i]!]!;
    if (s > phaseBest) {
      phaseBest = s;
      phase = ph;
    }
  }
  const downbeats = beats.filter((_, i) => i % 4 === phase);

  // Transients: strong local maxima at least 120 ms apart.
  const mean = env.reduce((a, b) => a + b, 0) / n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (env[i]! - mean) ** 2;
  const thr = mean + 2 * Math.sqrt(v / n);
  const gap = Math.round(0.12 * fr);
  const onsets: number[] = [];
  let last = -gap;
  for (let i = 1; i < n - 1; i++) {
    if (env[i]! > thr && env[i]! >= env[i - 1]! && env[i]! >= env[i + 1]! && i - last >= gap) {
      onsets.push(lagSeconds(i));
      last = i;
    }
  }

  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const sections = features ? detectSections({ ...features, flux: envelopeRaw }, confidence > 0.15 ? beats : []) : [];
  return {
    bpm: Math.round(((60 * fr) / period) * 10) / 10,
    beats: beats.map(r3),
    strengths,
    downbeats: downbeats.map(r3),
    onsets: onsets.map(r3),
    confidence: Math.round(confidence * 100) / 100,
    sections: sections.map((x) => ({ ...x, time: r3(x.time), energy: Math.round(x.energy * 100) / 100 })),
  };
}

/** Structure analysis window, seconds. */
const SEC_WIN = 0.5;
/** Seconds compared on each side of a candidate boundary. */
const SEC_SPAN = 3;
/** Minimum section length, seconds. */
const SEC_MIN = 4;

/**
 * Song sections from loudness, brightness and onset density. A boundary is a
 * peak of novelty (how different the next SEC_SPAN seconds are from the
 * previous ones), refined to the sharpest change nearby and snapped to the
 * nearest beat (0.3 s). Labels come
 * from the loudness change across the boundary and the level of the section:
 * drop (big rise into a loud part), breakdown (big fall), build (a rising part
 * that ends in a drop), intro/outro at the ends, change otherwise.
 */
export function detectSections(f: StructureFeatures, beats: number[] = []): SectionInfo[] {
  const fr = ANALYSIS_SR / HOP;
  const per = Math.max(1, Math.round(SEC_WIN * fr));
  const nw = Math.floor(Math.min(f.rms.length, f.bright.length, f.flux.length) / per);
  if (nw * SEC_WIN < SEC_MIN * 2) return nw > 0 ? [{ time: 0, label: "intro", energy: 1 }] : [];
  const mean = (a: number[], i0: number, i1: number) => {
    let s = 0;
    for (let i = i0; i < i1; i++) s += a[i]!;
    return s / Math.max(1, i1 - i0);
  };
  // Window features: loudness (dB), brightness, onset density.
  const L: number[] = [];
  const B: number[] = [];
  const O: number[] = [];
  // Loudness = power average (percussive parts read as loud as they sound).
  const pow = f.rms.map((r) => r * r);
  const dbOf = (h0: number, h1: number) => 10 * Math.log10(mean(pow, h0, h1) + 1e-10);
  for (let w = 0; w < nw; w++) {
    const a = w * per;
    L.push(dbOf(a, a + per));
    B.push(mean(f.bright, a, a + per));
    O.push(mean(f.flux, a, a + per));
  }
  const z = (a: number[]) => {
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length) || 1;
    return a.map((x) => (x - m) / sd);
  };
  const [Lz, Bz, Oz] = [z(L), z(B), z(O)];
  const K = Math.round(SEC_SPAN / SEC_WIN);
  const nov = new Array<number>(nw).fill(0);
  const dL = new Array<number>(nw).fill(0);
  for (let w = 2; w < nw - 2; w++) {
    const a0 = Math.max(0, w - K);
    const a1 = Math.min(nw, w + K);
    const d = (arr: number[]) => mean(arr, w, a1) - mean(arr, a0, w);
    dL[w] = d(L);
    nov[w] = Math.abs(d(Lz)) + 0.7 * Math.abs(d(Bz)) + 0.5 * Math.abs(d(Oz));
  }
  const minGap = Math.round(SEC_MIN / SEC_WIN);
  // Robust threshold (median + scaled MAD over the interior), so a fade-in or
  // the final fade does not hide every change in between.
  const inner = nov.slice(minGap / 2, nw - minGap / 2).sort((a, b) => a - b);
  const med = inner[Math.floor(inner.length / 2)] ?? 0;
  const mad = [...inner.map((v) => Math.abs(v - med))].sort((a, b) => a - b)[Math.floor(inner.length / 2)] ?? 0;
  // Capped: in a short piece with few changes most windows sit near a change, the median rises
  // and the robust threshold would exceed even a 2-sd jump (a drop in a 20 s track).
  const thr = Math.min(med + 1.2 * 1.4826 * mad, 2.5);
  // Greedy: strongest novelty peaks first, at least SEC_MIN apart and away from the ends.
  const cand = nov
    .map((v, w) => ({ v, w }))
    .filter(({ v, w }) => v > thr && v >= (nov[w - 1] ?? 0) && v >= (nov[w + 1] ?? 0) && w >= minGap / 2 && w <= nw - minGap / 2);
  cand.sort((a, b) => b.v - a.v);
  const bounds: number[] = [];
  for (const c of cand) if (bounds.every((b) => Math.abs(b - c.w) >= minGap)) bounds.push(c.w);
  // The wide novelty window finds the area of a change; place it on the sharpest
  // 1-second change nearby (a riser's start is not the drop that follows it).
  const sharp = (w: number) => {
    const d = (arr: number[]) => mean(arr, w, Math.min(nw, w + 2)) - mean(arr, Math.max(0, w - 2), w);
    return Math.abs(d(Lz)) + 0.7 * Math.abs(d(Bz));
  };
  for (let i = 0; i < bounds.length; i++) {
    let best = bounds[i]!;
    for (let w = Math.max(2, bounds[i]! - 4); w <= Math.min(nw - 2, bounds[i]! + 4); w++) if (sharp(w) > sharp(best)) best = w;
    bounds[i] = best;
  }
  // Short dropouts (0.5–4 s, ≥ 8 dB under the music on BOTH sides) are too
  // short for the novelty window but are the breath before a drop: keep both edges.
  const ctxW = Math.round(4 / SEC_WIN);
  const level60 = (a: number, b: number) => {
    const xs = L.slice(Math.max(0, a), Math.min(nw, b)).sort((x, y) => x - y);
    return xs.length ? xs[Math.floor(xs.length * 0.6)]! : -Infinity;
  };
  for (let w = 2; w < nw - 2; ) {
    const before = level60(w - ctxW, w);
    if (L[w]! > before - 8) {
      w++;
      continue;
    }
    let e = w;
    while (e < nw && L[e]! <= before - 6) e++;
    const after = level60(e, e + ctxW);
    if (e - w <= Math.round(4 / SEC_WIN) && e < nw - 2 && mean(L, w, e) <= after - 8)
      for (const b of [w, e]) if (bounds.every((x) => Math.abs(x - b) >= 2)) bounds.push(b);
    w = e + 1;
  }
  bounds.sort((a, b) => a - b);
  void dL;

  // Section levels: loudness of the sustained part (60th percentile), robust to fades.
  const edges = [0, ...bounds, nw];
  const level = edges.slice(0, -1).map((a, i) => {
    const xs = L.slice(a, edges[i + 1]).sort((x, y) => x - y);
    return xs[Math.floor(xs.length * 0.6)] ?? -100;
  });
  const lo = Math.min(...level);
  const hi = Math.max(...level);
  const energy = level.map((l) => (hi - lo > 1e-6 ? (l - lo) / (hi - lo) : 1));
  /** Loudness slope in dB per second over windows [a, b) (least squares). */
  const slope = (a: number, b: number) => {
    const n = b - a;
    if (n < 3) return 0;
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    for (let i = a; i < b; i++) {
      const x = (i - a) * SEC_WIN;
      sx += x;
      sy += L[i]!;
      sxy += x * L[i]!;
      sxx += x * x;
    }
    return (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx);
  };
  /**
   * Time of the sharpest loudness step (hop resolution) within a window of
   * boundary w. Half-second power spans: long enough to always hold a beat.
   */
  const stepTime = (w: number) => {
    const span = Math.round(0.5 * fr);
    let best = w * per;
    let bestD = -1;
    for (let h = Math.max(span, (w - 1) * per); h <= Math.min(pow.length - span, (w + 1) * per); h++) {
      const d = Math.abs(dbOf(h, h + span) - dbOf(h - span, h));
      if (d > bestD) [best, bestD] = [h, d];
    }
    // Hop h analyses the WIN samples ending at HOP·h + WIN, so the change enters it there.
    return (best * HOP + WIN) / ANALYSIS_SR;
  };
  /** A riser just before window w: brightness or loudness climbing over the last 4 s. */
  const riser = (w: number) => {
    const a = Math.max(0, w - 8);
    const m = Math.max(a + 1, w - 4);
    return mean(Bz, m, w) - mean(Bz, a, m) > 0.6 || slope(a, w) > 1.5;
  };
  const out: SectionInfo[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i]!;
    const last = i === edges.length - 2;
    const jump = i > 0 ? level[i]! - level[i - 1]! : 0;
    let label: SectionLabel;
    if (i === 0) label = "intro";
    else if (jump >= 4 && energy[i]! >= 0.6) label = "drop";
    else if (jump <= -4) label = last ? "outro" : "breakdown";
    else if (last && slope(a, edges[i + 1]!) < -1.5) label = "outro";
    // The hit after a riser is the drop even when the master is loudness-flat.
    else if (riser(a)) label = "drop";
    else label = "change";
    out.push({ time: i === 0 ? 0 : stepTime(a), label, energy: energy[i]! });
  }
  // A part that rises into a drop is a build (risers, filter sweeps).
  for (let i = 1; i < out.length - 1; i++) if (out[i + 1]!.label === "drop" && out[i]!.label === "change" && slope(edges[i]!, edges[i + 1]!) > 0.6) out[i]!.label = "build";
  // Snap boundaries to the nearest beat.
  for (const sct of out.slice(1)) {
    let best = sct.time;
    let dist = 0.3;
    for (const d of beats)
      if (Math.abs(d - sct.time) < dist) {
        best = d;
        dist = Math.abs(d - sct.time);
      }
    sct.time = best;
  }
  return out;
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** In-place iterative radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}
