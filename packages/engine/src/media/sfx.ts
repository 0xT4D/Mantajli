/**
 * Procedural sound effects for montage sound design: whooshes for whip pans,
 * risers into drops, impacts on hits, glitch stutters, UI blips, downlifters.
 *
 * Pure DSP (seeded noise, state-variable filters, oscillators), rendered to a
 * 48 kHz stereo 16-bit WAV. The output is original material, so it is free to
 * use in any export. Same parameters → identical file.
 */

import { SFX_SPECS, type SfxKind } from "@mantagli/core";

export { SFX_KINDS, SFX_SPECS, sfxPlacement, type SfxKind } from "@mantagli/core";

export interface SfxOptions {
  /** Seconds (risers/downlifters/whooshes stretch; others ignore it). */
  duration?: number;
  /** Pitch multiplier (1 = default). */
  pitch?: number;
  seed?: number;
}


const SR = 48000;

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

/** Chamberlin state-variable filter (cutoff in Hz, per sample). */
function svf() {
  let lp = 0;
  let bp = 0;
  return (x: number, fc: number, q = 0.7) => {
    const f = 2 * Math.sin((Math.PI * Math.min(Math.max(fc, 20), SR / 6)) / SR);
    lp += f * bp;
    const hp = x - lp - (1 / q) * bp;
    bp += f * hp;
    return { lp, bp, hp };
  };
}

/** Render a sound effect to stereo float buffers. */
export function synthesizeSfx(kind: SfxKind, opts: SfxOptions = {}): { left: Float32Array; right: Float32Array } {
  const spec = SFX_SPECS[kind];
  const dur = Math.min(12, Math.max(0.05, opts.duration ?? spec.duration));
  const pitch = Math.min(4, Math.max(0.25, opts.pitch ?? 1));
  const n = Math.round(dur * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const rnd = rng(opts.seed ?? 1);
  const fl = svf();
  const fr = svf();
  let ph = 0;
  let ph2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const u = t / dur;
    let l = 0;
    let r = 0;
    switch (kind) {
      case "whoosh": {
        // Band-passed noise; swells to the peak at `anchor`, cutoff follows, pans across.
        const a = spec.anchor;
        const env = u < a ? Math.pow(u / a, 2.2) : Math.pow(Math.max(0, (1 - u) / (1 - a)), 1.6);
        const fc = (500 + 5000 * env) * pitch;
        const pan = -0.8 + 1.6 * u;
        const nl = fl(rnd(), fc, 1.4).bp;
        const nr = fr(rnd(), fc * 1.07, 1.4).bp;
        l = nl * env * (1 - pan) * 0.9;
        r = nr * env * (1 + pan) * 0.9;
        break;
      }
      case "riser": {
        // Noise sweep 300 Hz → 8 kHz plus a saw climbing two octaves; ends at full level.
        const e = u * u;
        const fc = (300 + 7700 * e) * pitch;
        const f0 = 110 * pitch * Math.pow(4, u);
        ph += f0 / SR;
        const saw = 2 * (ph % 1) - 1;
        const noise = (fl(rnd(), fc, 2.5).bp + fr(rnd(), fc * 1.03, 2.5).bp) * 0.5;
        const v = noise * e * 1.1 + saw * e * 0.12;
        const fade = Math.min(1, (dur - t) / 0.01);
        l = v * fade * (0.9 + 0.1 * Math.sin(t * 9));
        r = v * fade * (0.9 - 0.1 * Math.sin(t * 9));
        break;
      }
      case "impact": {
        // Sub boom 95 → 32 Hz, soft-clipped, plus a low-passed noise burst.
        const f = (32 + 63 * Math.exp(-t / 0.22)) * pitch;
        ph += (2 * Math.PI * f) / SR;
        const boom = Math.tanh(2.2 * Math.sin(ph)) * Math.exp(-t / 0.9);
        const burst = fl(rnd(), (700 + 3500 * Math.exp(-t / 0.25)) * pitch, 0.7).lp * Math.exp(-t / 0.4) * 1.4;
        const click = t < 0.003 ? rnd() * (1 - t / 0.003) : 0;
        l = (boom * 0.85 + burst + click) * Math.min(1, (dur - t) / 0.05);
        r = (boom * 0.85 + fr(rnd(), (700 + 3500 * Math.exp(-t / 0.25)) * pitch, 0.7).lp * Math.exp(-t / 0.4) * 1.4 + click) * Math.min(1, (dur - t) / 0.05);
        break;
      }
      case "hit": {
        const f = (55 + 140 * Math.exp(-t / 0.03)) * pitch;
        ph += (2 * Math.PI * f) / SR;
        const body = Math.tanh(1.8 * Math.sin(ph)) * Math.exp(-t / 0.12);
        const snap = fl(rnd(), 2500 * pitch, 0.9).bp * Math.exp(-t / 0.05) * 1.6;
        l = (body + snap) * 0.9;
        r = (body + fr(rnd(), 2500 * pitch, 0.9).bp * Math.exp(-t / 0.05) * 1.6) * 0.9;
        break;
      }
      case "glitch": {
        // 30 ms slices: each a random square tone, noise burst or silence, bit-crushed.
        const slice = Math.floor(t / 0.03);
        const sr2 = rng((opts.seed ?? 1) * 977 + slice);
        const mode = sr2() * 0.5 + 0.5;
        const f = (300 + 2500 * (sr2() * 0.5 + 0.5)) * pitch;
        ph += f / SR;
        let v = mode < 0.45 ? (ph % 1 < 0.5 ? 1 : -1) * 0.5 : mode < 0.85 ? rnd() * 0.7 : 0;
        v = Math.round(v * 6) / 6; // crush
        const env = Math.exp(-((t % 0.03) / 0.03) * 1.5) * Math.min(1, (dur - t) / 0.01);
        l = v * env;
        r = (sr2() > 0 ? v : -v) * env;
        break;
      }
      case "blip": {
        const f = 1800 * pitch;
        ph += f / SR;
        ph2 += (f * 2) / SR;
        const v = (Math.sin(2 * Math.PI * ph) * 0.8 + (ph2 % 1 < 0.5 ? 0.15 : -0.15)) * Math.exp(-t / 0.035) * Math.min(1, t / 0.002);
        l = v * 0.7;
        r = v * 0.7;
        break;
      }
      case "downlifter": {
        const e = Math.pow(1 - u, 1.5);
        const fc = (300 + 6000 * e) * pitch;
        const f0 = 440 * pitch * Math.pow(0.25, u);
        ph += f0 / SR;
        const v = (fl(rnd(), fc, 2).bp * 0.9 + Math.sin(2 * Math.PI * ph) * 0.15) * e * Math.min(1, t / 0.01);
        l = v;
        r = v * 0.95;
        break;
      }
    }
    L[i] = l;
    R[i] = r;
  }
  // Normalise to -1 dBFS peak.
  let peak = 1e-9;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
  const g = 0.891 / peak;
  for (let i = 0; i < n; i++) {
    L[i]! *= g;
    R[i]! *= g;
  }
  return { left: L, right: R };
}

/** 16-bit PCM stereo WAV bytes at 48 kHz. */
export function encodeWav(left: Float32Array, right: Float32Array): Buffer {
  const n = left.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i]!)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i]!)) * 32767), 46 + i * 4);
  }
  return buf;
}

