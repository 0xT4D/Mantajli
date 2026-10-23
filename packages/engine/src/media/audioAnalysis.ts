/**
 * Audio analysis: waveform peaks, tempo, beat tracking, downbeats and
 * transient onsets.
 *
 * Onset envelope = log-magnitude spectral flux. Tempo = autocorrelation of the
 * envelope with a log-normal prior around 120 BPM. Beats = dynamic-programming
 * beat tracker (Ellis 2007). Results are estimates; markers stay editable.
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

export interface BeatResult {
  bpm: number;
  beats: number[];
  strengths: number[];
  downbeats: number[];
  onsets: number[];
  confidence: number;
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
    fft(this.re, this.im);
    const bins = WIN / 2;
    const mag = new Float32Array(bins);
    for (let k = 0; k < bins; k++) mag[k] = Math.log1p(100 * Math.hypot(this.re[k]!, this.im[k]!));
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

export function detectBeats(envelopeRaw: number[]): BeatResult {
  const fr = ANALYSIS_SR / HOP; // envelope frames per second (~86)
  const n = envelopeRaw.length;
  const empty: BeatResult = { bpm: 0, beats: [], strengths: [], downbeats: [], onsets: [], confidence: 0 };
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
  return {
    bpm: Math.round(((60 * fr) / period) * 10) / 10,
    beats: beats.map(r3),
    strengths,
    downbeats: downbeats.map(r3),
    onsets: onsets.map(r3),
    confidence: Math.round(confidence * 100) / 100,
  };
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
