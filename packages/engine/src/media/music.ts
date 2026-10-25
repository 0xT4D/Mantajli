/**
 * Procedural music for montages: an original, structure-aware score (intro, builds, drops,
 * breakdown, outro) at a chosen tempo, style and mood, rendered to a 48 kHz stereo WAV.
 *
 * This is an algorithmic synthesizer (oscillators, filtered noise, a Schroeder reverb), not a
 * neural model: it produces genre-shaped arrangements with a known structure. The point for
 * editing is that the beat grid and section boundaries are exact (they are where the notes were
 * written), so cuts, titles and effects can lock to them without detection error. The output is
 * original material and free to use. Same options → identical file.
 */

import { MUSIC_STYLE_SPECS, type MusicMood, type MusicSectionKind, type MusicStyle } from "@mantagli/core";

export { MUSIC_MOODS, MUSIC_SECTION_KINDS, MUSIC_STYLE_SPECS, MUSIC_STYLES, type MusicMood, type MusicSectionKind, type MusicStyle } from "@mantagli/core";

export interface MusicSection {
  kind: MusicSectionKind;
  bars: number;
}

export interface MusicOptions {
  style: MusicStyle;
  mood: MusicMood;
  /** Seconds; the file is exactly this long (the outro holds to the end). */
  duration: number;
  bpm?: number;
  /** Explicit structure (4/4 bars); otherwise planned from the duration. */
  sections?: MusicSection[];
  seed?: number;
}

export interface MusicResult {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  bpm: number;
  /** Beat times (s); every 4th is a downbeat (bar start). */
  beats: number[];
  downbeats: number[];
  sections: { time: number; label: MusicSectionKind; energy: number; bars: number }[];
  duration: number;
}

const SR = 48000;
/** Bump when the rendered audio changes, so cached files of the same settings are composed again. */
export const MUSIC_GENERATOR_VERSION = 2;

const ENERGY: Record<MusicSectionKind, number> = { intro: 0.25, build: 0.55, drop: 1, breakdown: 0.3, outro: 0.4 };

/**
 * Plan a structure that fills `totalBars`: intro, build, drop, (breakdown, build, drop), outro.
 * Drops get the bulk; short pieces collapse to intro / build / drop / outro.
 */
export function planMusicSections(totalBars: number): MusicSection[] {
  const n = Math.max(4, Math.floor(totalBars));
  // Drops last whole 4-bar phrases; bars left over lengthen the outro (it holds the final chord).
  const phrase = (b: number) => (b >= 4 ? 4 * Math.floor(b / 4) : b);
  if (n < 10) {
    const drop = phrase(n - 3);
    return [{ kind: "intro", bars: 1 }, { kind: "build", bars: 1 }, { kind: "drop", bars: drop }, { kind: "outro", bars: n - 2 - drop }];
  }
  const intro = Math.min(8, Math.max(2, 2 * Math.round((n * 0.14) / 2)));
  const rest = n - intro - (n < 16 ? 1 : 2);
  if (rest < 14) {
    const drop = phrase(rest - 2);
    return [{ kind: "intro", bars: intro }, { kind: "build", bars: 2 }, { kind: "drop", bars: drop }, { kind: "outro", bars: n - intro - 2 - drop }];
  }
  const breakdown = rest >= 24 ? 4 : 2;
  const drops = rest - 2 - breakdown - 2;
  const dropA = phrase(Math.floor(drops / 2));
  const dropB = phrase(drops - dropA);
  return [
    { kind: "intro", bars: intro },
    { kind: "build", bars: 2 },
    { kind: "drop", bars: dropA },
    { kind: "breakdown", bars: breakdown },
    { kind: "build", bars: 2 },
    { kind: "drop", bars: dropB },
    { kind: "outro", bars: n - intro - 2 - dropA - breakdown - 2 - dropB },
  ];
}

const PROGRESSIONS: Record<MusicMood, { tonic: number; chords: [number, "m" | "M"][] }> = {
  dark: { tonic: 52, chords: [[0, "m"], [8, "M"], [3, "M"], [10, "M"]] }, // i VI III VII (Em C G D)
  tense: { tonic: 52, chords: [[0, "m"], [8, "M"], [5, "m"], [7, "M"]] }, // i VI iv V (Em C Am B)
  uplifting: { tonic: 48, chords: [[0, "M"], [7, "M"], [9, "m"], [5, "M"]] }, // I V vi IV (C G Am F)
};

const midiHz = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

export function generateMusic(opts: MusicOptions): MusicResult {
  const style = opts.style;
  const bpm = Math.min(180, Math.max(60, opts.bpm ?? MUSIC_STYLE_SPECS[style].bpm));
  const duration = Math.min(600, Math.max(4, opts.duration));
  const beat = 60 / bpm;
  const bar = 4 * beat;
  const N = Math.round(duration * SR);
  const fitBars = Math.max(4, Math.floor(duration / bar + 1e-6));
  const plan = opts.sections?.length ? fitSections(opts.sections, fitBars) : planMusicSections(fitBars);
  const seed = opts.seed ?? 1;

  // ------------------------------------------------------------ buffers and mixing
  const L = new Float32Array(N);
  const R = new Float32Array(N);
  const verbL = new Float32Array(N);
  const verbR = new Float32Array(N);
  let rs = (seed * 2654435761 + 7) >>> 0 || 1;
  const rnd = () => ((rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const at = (t: number) => Math.floor(t * SR);
  const add = (t0: number, dur: number, fn: (x: number, i: number) => number, gain = 1, pan = 0, send = 0) => {
    const s0 = at(t0);
    if (s0 >= N || s0 < 0) return;
    const n = Math.min(at(dur), N - s0);
    const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < n; i++) {
      const v = fn(i / SR, i);
      L[s0 + i]! += v * gl;
      R[s0 + i]! += v * gr;
      if (send) {
        verbL[s0 + i]! += v * gl * send;
        verbR[s0 + i]! += v * gr * send;
      }
    }
  };
  const svf = () => {
    let lp = 0;
    let bp = 0;
    return (x: number, fc: number, q = 0.7) => {
      const f = 2 * Math.sin((Math.PI * Math.min(Math.max(fc, 20), SR / 6)) / SR);
      lp += f * bp;
      const hp = x - lp - (1 / q) * bp;
      bp += f * hp;
      return { lp, bp, hp };
    };
  };

  // ------------------------------------------------------------ timeline of sections
  const sections: MusicResult["sections"] = [];
  let tCursor = 0;
  for (const s of plan) {
    sections.push({ time: tCursor, label: s.kind, energy: ENERGY[s.kind], bars: s.bars });
    tCursor += s.bars * bar;
  }
  const sectionAt = (t: number) => {
    let cur = sections[0]!;
    for (const s of sections) if (t + 1e-9 >= s.time) cur = s;
    return cur;
  };
  const sectionEnd = (s: (typeof sections)[number]) => (s === sections[sections.length - 1] ? duration : s.time + s.bars * bar);
  const kindAt = (t: number) => sectionAt(t).label;
  const isDrop = (t: number) => kindAt(t) === "drop";

  // ------------------------------------------------------------ harmony
  const prog = PROGRESSIONS[opts.mood];
  const transpose = (((seed % 5) + 5) % 5) - 2;
  const chordAt = (t: number) => {
    const [root, q] = prog.chords[Math.floor(t / bar + 1e-6) % prog.chords.length]!;
    let r = prog.tonic + transpose + root;
    while (r > 59) r -= 12;
    while (r < 48) r += 12;
    const third = q === "m" ? 3 : 4;
    return { root: r, notes: [r, r + third, r + 7, r + 12] };
  };

  // ------------------------------------------------------------ sidechain pump from the kicks
  const kickTimes: number[] = [];
  const pump = new Float32Array(N).fill(1);
  const pumpAt = (s: number) => (s >= 0 && s < N ? pump[s]! : 1);

  // ------------------------------------------------------------ instruments
  const kick = (t: number, g = 1) => {
    kickTimes.push(t);
    let ph = 0;
    add(t, 0.5, (x) => {
      const f = 48 + 120 * Math.exp(-x / 0.03);
      ph += (2 * Math.PI * f) / SR;
      return Math.tanh(1.7 * Math.sin(ph) * Math.exp(-x / 0.28)) * 0.9 + (x < 0.003 ? rnd() * (1 - x / 0.003) * 0.4 : 0);
    }, g);
  };
  const snare = (t: number, g = 1, clap = false) => {
    const f = svf();
    add(t, 0.35, (x) => f(rnd(), clap ? 1500 : 2200, 0.8).bp * (clap ? Math.exp(-x / 0.06) * (x < 0.02 ? 0.6 + 0.4 * Math.sin(x * 900) : 1) : Math.exp(-x / 0.1)) * 2 + (clap ? 0 : Math.sin(2 * Math.PI * 200 * x) * Math.exp(-x / 0.04) * 0.5), g * 0.5, 0.05, 0.3);
  };
  const hat = (t: number, g = 1, open = false) => {
    const f = svf();
    add(t, open ? 0.25 : 0.05, (x) => f(rnd(), 9500, 0.8).hp * Math.exp(-x / (open ? 0.08 : 0.015)), g * 0.2, 0.3);
  };
  const tick = (t: number, g = 1) => add(t, 0.03, (x) => Math.sin(2 * Math.PI * 2600 * x) * Math.exp(-x / 0.006), g * 0.16, -0.3, 0.5);
  const tom = (t: number, g = 1, pitch = 1) => {
    let ph = 0;
    add(t, 0.9, (x) => {
      ph += (2 * Math.PI * (70 * pitch + 60 * Math.exp(-x / 0.05))) / SR;
      return Math.tanh(1.4 * Math.sin(ph)) * Math.exp(-x / 0.35) + rnd() * Math.exp(-x / 0.02) * 0.3;
    }, g * 0.75, 0, 0.5);
  };
  const pad = (t0: number, dur: number, notes: number[], cut: (t: number) => number, gain: number, attack = 0.05, duck = true) => {
    notes.forEach((note, k) => {
      for (const [det, pan] of [[-0.1, -0.6], [0.1, 0.6]] as const) {
        const f = svf();
        let ph = (k * 0.37 + det + 1) % 1;
        const freq = midiHz(note) * Math.pow(2, det / 12);
        add(t0, dur + 0.6, (x) => {
          ph += freq / SR;
          const saw = 2 * (ph % 1) - 1;
          const t = t0 + x;
          const env = Math.min(1, x / attack) * (x > dur ? Math.max(0, 1 - (x - dur) / 0.6) : 1);
          const d = duck && isDrop(t) ? pumpAt(at(t)) : 1;
          return f(saw, cut(t), 0.8).lp * env * d;
        }, gain, pan, 0.45);
      }
    });
  };
  const bassNote = (t: number, len: number, note: number, g = 1, bright = 2000) => {
    const f = svf();
    let ph = 0;
    add(t, len, (x) => {
      ph += midiHz(note) / SR;
      const saw = 2 * (ph % 1) - 1;
      return (f(saw, 250 + bright * Math.exp(-x / 0.05), 1.3).lp * 0.8 + Math.sin(2 * Math.PI * ph) * 0.7) * Math.min(1, x / 0.004) * Math.exp(-x / (len * 0.35));
    }, 0.4 * g);
  };
  const lead = (t: number, len: number, note: number, g: number, bright: number, pan: number, square = true) => {
    const f = svf();
    let ph = 0;
    add(t, len, (x, i) => {
      ph += midiHz(note) / SR;
      const w = square ? (ph % 1 < 0.5 ? 1 : -1) : Math.sin(2 * Math.PI * ph) + 0.3 * Math.sin(4 * Math.PI * ph);
      return f(w, bright, 1).lp * Math.exp(-x / (len * 0.6)) * (isDrop(t) ? 0.6 + 0.4 * pumpAt(at(t) + i) : 1);
    }, g, pan, 0.35);
  };
  const braam = (t: number, root: number, g = 1) => {
    for (const [det, pan] of [[-0.15, -0.5], [0, 0], [0.15, 0.5]] as const) {
      const f = svf();
      let ph = rnd() * 0.5 + 0.5;
      add(t, bar * 0.95, (x) => {
        ph += midiHz(root - 12) * Math.pow(2, det / 12) / SR;
        const env = Math.min(1, x / 0.08) * Math.exp(-x / 1.6);
        return Math.tanh(1.5 * f(2 * (ph % 1) - 1, 200 + 1400 * Math.exp(-x / 0.4), 1.2).lp) * env;
      }, 0.22 * g, pan, 0.4);
    }
  };
  const riser = (t0: number, dur: number, g = 1) => {
    const f = svf();
    let ph = 0;
    add(t0, dur, (x) => {
      const u = x / dur;
      ph += (180 * Math.pow(4, u)) / SR;
      return f(rnd(), 300 + 7500 * u * u, 2.5).bp * u * u + (2 * (ph % 1) - 1) * u * u * 0.08;
    }, 0.45 * g, 0, 0.4);
  };
  const downlifter = (t0: number, dur: number, g = 1) => {
    const f = svf();
    add(t0, dur, (x) => f(rnd(), 300 + 6000 * (1 - x / dur) ** 1.5, 2).bp * (1 - x / dur) ** 1.5, 0.35 * g, 0, 0.5);
  };
  const impact = (t: number, g = 1) => {
    let ph = 0;
    add(t, 3.5, (x) => {
      ph += (2 * Math.PI * (32 + 60 * Math.exp(-x / 0.22))) / SR;
      return Math.tanh(2 * Math.sin(ph)) * Math.exp(-x / 1);
    }, g * 0.7, 0, 0.3);
    const n = svf();
    add(t, 2, (x) => n(rnd(), 800 + 3000 * Math.exp(-x / 0.3), 0.7).lp * Math.exp(-x / 0.45), g * 0.6, 0, 0.8);
  };
  const breath = (t: number) => {
    // A short gap before a drop makes it land harder.
    for (let i = Math.max(0, at(t - 0.12)); i < Math.min(N, at(t)); i++) {
      L[i]! *= 0.08;
      R[i]! *= 0.08;
    }
  };

  // ------------------------------------------------------------ arrangement
  // Kicks first (they drive the pump other parts read).
  for (const s of sections) {
    const t1 = sectionEnd(s);
    for (let t = s.time; t < t1 - 1e-6; t += beat) {
      const lastBarOfBuild = s.label === "build" && t >= t1 - bar;
      const halfTime = Math.round((t - s.time) / beat) % 2 === 0;
      const kickHere =
        s.label === "drop" ||
        (style === "techno" && (s.label === "build" ? !lastBarOfBuild : s.label === "intro" ? s.bars >= 4 && t >= s.time + (s.bars * bar) / 2 : s.label === "outro" ? t < s.time + bar : false)) ||
        // Synthwave: a half-time kick drives the build (out for the roll) and rides out the first outro bar.
        (style === "synthwave" && halfTime && ((s.label === "build" && !lastBarOfBuild) || (s.label === "outro" && t < s.time + bar)));
      if (kickHere && style !== "cinematic") kick(t, s.label === "drop" ? 1 : 0.85);
    }
  }
  for (const t of kickTimes) {
    const s0 = at(t);
    for (let i = 0; i < at(0.4) && s0 + i < N; i++) pump[s0 + i] = Math.min(pump[s0 + i]!, 1 - 0.6 * Math.exp(-i / SR / 0.11));
  }

  const dropIndex = (s: (typeof sections)[number]) => sections.filter((x) => x.label === "drop").indexOf(s);
  for (const s of sections) {
    const t0 = s.time;
    const t1 = sectionEnd(s);
    const bars = Math.max(1, Math.round((t1 - t0) / bar));
    const second = s.label === "drop" && dropIndex(s) > 0;
    const next = sections[sections.indexOf(s) + 1];

    // Harmony bed (pads or drones) for every bar.
    for (let b = 0; b < bars; b++) {
      const tb = t0 + b * bar;
      if (tb >= duration) break;
      const ch = chordAt(tb);
      const len = Math.min(bar, duration - tb);
      const cut =
        s.label === "intro" ? (t: number) => 350 + 1100 * ((t - t0) / Math.max(bar, t1 - t0)) ** 2
        : s.label === "build" ? (t: number) => 900 + 1800 * ((t - t0) / (t1 - t0))
        : s.label === "breakdown" ? () => 1100
        : s.label === "outro" ? (t: number) => 2400 * Math.exp(-(t - t0) / 3) + 300
        : () => (second ? 3200 : 2600);
      if (style === "techno") {
        if (s.label !== "drop") pad(tb, len, ch.notes.slice(0, 3), cut, 0.028, 0.3);
      } else pad(tb, len, ch.notes, cut, style === "cinematic" ? 0.05 : 0.04, s.label === "intro" && b === 0 ? 1.2 : style === "cinematic" ? 0.4 : 0.05, style !== "cinematic");
    }

    if (s.label === "intro") {
      if (style === "cinematic") add(t0, t1 - t0, (x) => Math.sin(2 * Math.PI * midiHz(chordAt(t0).root - 24) * x) * Math.min(1, x / 2), 0.22);
      else add(t0, t1 - t0, (x) => Math.sin(2 * Math.PI * midiHz(chordAt(t0).root - 24) * x) * Math.min(1, x / 2), style === "techno" ? 0.08 : 0.18);
      for (let t = t0; t < t1 - 1e-6; t += beat) tick(t, 0.4 + 0.6 * ((t - t0) / (t1 - t0)));
      if (style === "cinematic") for (let t = t0 + beat; t < t1; t += 2 * beat) lead(t, beat * 1.8, chordAt(t).notes[(Math.round(t / beat) % 3) + 1]! + 12, 0.05, 2600, 0.2, false);
    }

    if (s.label === "build") {
      const riseLen = Math.min(t1 - t0, 8 * beat);
      riser(t1 - riseLen, riseLen, 1);
      // Accelerating roll (snare, or toms for cinematic) over the last bar.
      for (let t = Math.max(t0, t1 - bar); t < t1 - 0.05; ) {
        const u = (t - (t1 - bar)) / bar;
        const step = u < 0.5 ? beat / 2 : u < 0.75 ? beat / 4 : beat / 8;
        if (style === "cinematic") tom(t, 0.3 + 0.6 * u, 1.3);
        else snare(t, 0.2 + 0.6 * u);
        t += step;
      }
      if (style === "cinematic") for (let t = t0; t < t1 - 1e-6; t += beat / 2) tick(t, 0.35 + 0.5 * ((t - t0) / (t1 - t0)));
      // An eighth-note bass pulse that swells through the build, so it climbs from the intro's level
      // instead of thinning out until the roll (techno's build already rides the kick and bass).
      if (style !== "techno") for (let t = t0; t < t1 - beat / 2 - 1e-6; t += beat / 2) bassNote(t, beat * 0.4, chordAt(t).root, 0.5 + 0.5 * ((t - t0) / (t1 - t0)), style === "cinematic" ? 700 : 1200 + 1600 * ((t - t0) / (t1 - t0)));
      for (let t = t0; t < t1 - 1e-6; t += beat / (style === "synthwave" ? 4 : 2)) {
        const ch = chordAt(t);
        const step = Math.round(t / (beat / 4)) % 8;
        if (style === "synthwave") lead(t, beat / 4, ch.notes[[0, 1, 2, 3, 2, 1, 3, 2][step]!]! + 12, 0.03 + 0.02 * ((t - t0) / (t1 - t0)), 1600 + 2000 * ((t - t0) / (t1 - t0)), step % 2 ? 0.35 : -0.35);
        else bassNote(t, beat / 2, ch.root - 12, 0.5, 800);
      }
      if (next?.label === "drop") breath(t1);
    }

    if (s.label === "drop") {
      impact(t0, second ? 1.1 : 1);
      for (let t = t0; t < t1 - 1e-6; t += beat) {
        const inBar = Math.round((t - t0) / beat) % 4;
        const ch = chordAt(t);
        if (style === "synthwave") {
          if (inBar === 1 || inBar === 3) snare(t, second ? 1.1 : 1);
          hat(t, 1);
          hat(t + beat / 2, 0.55);
          bassNote(t + beat / 2, beat * 0.45, ch.root - 12, 1);
          for (let k = 0; k < 4; k++) {
            const tt = t + (k * beat) / 4;
            const step = Math.round(tt / (beat / 4)) % 8;
            const note = ch.notes[[0, 1, 2, 3, 2, 1, 3, 2][step]!]! + 12 + (second && step % 4 === 3 ? 12 : 0);
            lead(tt, beat / 4, note, second ? 0.055 : 0.045, second ? 5200 : 3000, step % 2 ? 0.35 : -0.35);
          }
        } else if (style === "techno") {
          if (inBar === 1 || inBar === 3) snare(t, 0.9, true);
          hat(t + beat / 2, 0.9, true);
          for (let k = 0; k < 4; k++) {
            hat(t + (k * beat) / 4, 0.35);
            if (k > 0) bassNote(t + (k * beat) / 4, beat / 4, ch.root - 12, 0.75, 900);
          }
          if (Math.floor((t - t0) / bar) % 2 === 0 && (inBar === 1 || inBar === 2)) for (const n of ch.notes.slice(0, 3)) lead(t + beat / 2, beat * 0.3, n + 12, 0.03, 2200, 0.2, false);
        } else {
          if (inBar === 0) braam(t, ch.root, second ? 1.15 : 1);
          if (inBar === 0 || inBar === 2) tom(t, 1);
          if (inBar === 3) {
            tom(t + beat / 2, 0.7, 1.2);
            tom(t + (3 * beat) / 4, 0.5, 1.4);
          }
          for (let k = 0; k < 2; k++) bassNote(t + (k * beat) / 2, beat / 2, ch.root - 12, 0.6, 600);
        }
      }
    }

    if (s.label === "breakdown") {
      downlifter(t0, Math.min(1.5, t1 - t0), 1);
      for (let t = t0; t < t1 - 1e-6; t += style === "cinematic" ? beat : beat / 2) {
        const ch = chordAt(t);
        const step = Math.round(t / (beat / 2)) % 4;
        lead(t, style === "cinematic" ? beat * 1.5 : beat / 2, ch.notes[[0, 2, 1, 3][step]!]! + 12, style === "cinematic" ? 0.05 : 0.03, 1400, step % 2 ? 0.3 : -0.3, style !== "cinematic");
      }
    }

    if (s.label === "outro") {
      impact(t0, 1.2);
      // Ride-out: the groove's bass (and the synthwave arpeggio) carry on through the first bar and fade,
      // so the tail after the last drop is music, not just a held chord.
      if (style !== "cinematic") {
        for (let t = t0; t < Math.min(t1, t0 + bar) - 1e-6; t += beat / 2) {
          const u = (t - t0) / bar;
          bassNote(t, beat * 0.4, chordAt(t0).root, 0.9 * (1 - 0.6 * u), 2000);
          if (style === "synthwave")
            for (let k = 0; k < 2; k++) {
              const tt = t + (k * beat) / 4;
              const step = Math.round(tt / (beat / 4)) % 8;
              lead(tt, beat / 4, chordAt(t0).notes[[0, 1, 2, 3, 2, 1, 3, 2][step]!]! + 12, 0.05 * (1 - 0.7 * u), 2800, step % 2 ? 0.35 : -0.35);
            }
        }
      }
      const ch = chordAt(t0);
      for (const note of [...ch.notes, ch.notes[1]! + 12]) {
        const f = svf();
        let ph = 0;
        const freq = midiHz(note);
        add(t0, duration - t0, (x) => {
          ph += freq / SR;
          return f(2 * (ph % 1) - 1, 2400 * Math.exp(-x / 1.5) + 300, 0.8).lp * Math.exp(-x / Math.max(1.2, (duration - t0) / 2.5));
        }, 0.05, 0, 0.6);
      }
    }
  }

  // ------------------------------------------------------------ reverb and master
  const reverb = (src: Float32Array, spread: number) => {
    const out = new Float32Array(N);
    const combs = [1557, 1617, 1491, 1422].map((d) => ({ buf: new Float32Array(d + spread), i: 0, lp: 0 }));
    const aps = [225, 556].map((d) => ({ buf: new Float32Array(d + spread), i: 0 }));
    for (let n = 0; n < N; n++) {
      let acc = 0;
      for (const c of combs) {
        const y = c.buf[c.i]!;
        c.lp = y * 0.75 + c.lp * 0.25;
        c.buf[c.i] = src[n]! + c.lp * 0.84;
        c.i = (c.i + 1) % c.buf.length;
        acc += y;
      }
      let y = acc * 0.25;
      for (const a of aps) {
        const b = a.buf[a.i]!;
        const v = y + b * 0.5;
        a.buf[a.i] = v;
        a.i = (a.i + 1) % a.buf.length;
        y = b - v * 0.5;
      }
      out[n] = y;
    }
    return out;
  };
  const rl = reverb(verbL, 0);
  const rr = reverb(verbR, 23);
  let peak = 1e-9;
  for (let i = 0; i < N; i++) {
    L[i] = Math.tanh((L[i]! + rl[i]! * 0.6) * 1.1);
    R[i] = Math.tanh((R[i]! + rr[i]! * 0.6) * 1.1);
    peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
  }
  // Peak at -1 dBFS; a 5 ms fade at the very end avoids a click.
  const g = 0.89 / peak;
  const fade = Math.min(N, at(0.005));
  for (let i = 0; i < N; i++) {
    const f = i >= N - fade ? (N - 1 - i) / fade : 1;
    L[i] = L[i]! * g * f;
    R[i] = R[i]! * g * f;
  }

  const beats: number[] = [];
  for (let i = 0; i * beat < duration - 1e-6; i++) beats.push(+(i * beat).toFixed(6));
  return {
    left: L,
    right: R,
    sampleRate: SR,
    bpm,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    sections: sections.filter((s) => s.time < duration).map((s) => ({ ...s, time: +s.time.toFixed(6) })),
    duration,
  };
}

/** Scale an explicit structure to the bars that fit (the outro absorbs the difference). */
function fitSections(sections: MusicSection[], fitBars: number): MusicSection[] {
  const out = sections.filter((s) => s.bars > 0).map((s) => ({ ...s, bars: Math.round(s.bars) }));
  let total = out.reduce((n, s) => n + s.bars, 0);
  while (total > fitBars && out.length) {
    const last = out[out.length - 1]!;
    const cut = Math.min(last.bars, total - fitBars);
    last.bars -= cut;
    total -= cut;
    if (last.bars === 0) out.pop();
  }
  if (total < fitBars) {
    const last = out[out.length - 1];
    if (last?.kind === "outro") last.bars += fitBars - total;
    else out.push({ kind: "outro", bars: fitBars - total });
  }
  return out;
}
