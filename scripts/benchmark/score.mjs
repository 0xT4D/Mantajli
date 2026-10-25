// Original score for the reference benchmark montage: 24 s, 120 BPM, E minor,
// 48 kHz stereo WAV. Structure (the edit follows it):
//   0-4 s   intro: filtered pad, ticks, riser from 2 s
//   4 s     DROP 1: kick, bass, arp, hats
//   12 s    breakdown: pad + arp only, downlifter
//   12.5-14 riser + snare roll
//   14 s    DROP 2: full, brighter arp
//   20 s    end hit, 4 s tail
// Usage: node scripts/benchmark/score.mjs <out.wav>
import { writeFileSync } from "node:fs";

const SR = 48000;
const LEN = 24;
const N = SR * LEN;
const L = new Float32Array(N);
const R = new Float32Array(N);
const verbL = new Float32Array(N);
const verbR = new Float32Array(N);
const BEAT = 0.5;

let seed = 7654321;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const at = (t) => Math.floor(t * SR);

function svf() {
  let lp = 0;
  let bp = 0;
  return (x, fc, q = 0.7) => {
    const f = 2 * Math.sin((Math.PI * Math.min(Math.max(fc, 20), SR / 6)) / SR);
    lp += f * bp;
    const hp = x - lp - (1 / q) * bp;
    bp += f * hp;
    return { lp, bp, hp };
  };
}

function add(t0, dur, fn, gain = 1, pan = 0, send = 0) {
  const s0 = at(t0);
  const n = Math.min(at(dur), N - s0);
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < n; i++) {
    const v = fn(i / SR, i);
    L[s0 + i] += v * gl;
    R[s0 + i] += v * gr;
    if (send) {
      verbL[s0 + i] += v * gl * send;
      verbR[s0 + i] += v * gr * send;
    }
  }
}

const inDrop = (t) => (t >= 4 && t < 12) || (t >= 14 && t < 20);

// ---------------------------------------------------------------- sidechain pump from the kicks
const kicks = [];
for (let t = 4; t < 12; t += BEAT) kicks.push(t);
for (let t = 14; t < 20; t += BEAT) kicks.push(t);
const pump = new Float32Array(N).fill(1);
for (const t of kicks) {
  const s0 = at(t);
  for (let i = 0; i < at(0.4) && s0 + i < N; i++) pump[s0 + i] = Math.min(pump[s0 + i], 1 - 0.6 * Math.exp(-i / SR / 0.11));
}

// ---------------------------------------------------------------- drums
function kick(t, g = 1) {
  let ph = 0;
  add(t, 0.5, (x) => {
    const f = 48 + 120 * Math.exp(-x / 0.03);
    ph += (2 * Math.PI * f) / SR;
    return Math.tanh(1.7 * Math.sin(ph) * Math.exp(-x / 0.28)) * 0.9 + (x < 0.003 ? rnd() * (1 - x / 0.003) * 0.4 : 0);
  }, g);
}
function snare(t, g = 1) {
  const f = svf();
  add(t, 0.35, (x) => f(rnd(), 2200, 0.8).bp * Math.exp(-x / 0.1) * 2 + Math.sin(2 * Math.PI * 200 * x) * Math.exp(-x / 0.04) * 0.5, g * 0.5, 0.05, 0.3);
}
function hat(t, g = 1) {
  const f = svf();
  add(t, 0.05, (x) => f(rnd(), 9500, 0.8).hp * Math.exp(-x / 0.015), g * 0.2, 0.3);
}
function tick(t, g = 1) {
  add(t, 0.03, (x) => Math.sin(2 * Math.PI * 2600 * x) * Math.exp(-x / 0.006), g * 0.16, -0.3, 0.5);
}
for (const t of kicks) kick(t, t >= 14 ? 1 : 0.92);
for (let t = 4 + BEAT; t < 12; t += 2 * BEAT) snare(t);
for (let t = 14 + BEAT; t < 20; t += 2 * BEAT) snare(t, 1.1);
for (let t = 4; t < 20; t += BEAT / 2) if (inDrop(t)) hat(t, Math.round(t * 4) % 2 ? 0.55 : 1);
for (let t = 0; t < 4; t += BEAT) tick(t, 0.5 + 0.5 * (t / 4));
// Snare roll into drop 2.
for (let t = 12.5; t < 13.95; ) {
  const step = t < 13 ? BEAT / 2 : t < 13.5 ? BEAT / 4 : BEAT / 8;
  snare(t, 0.2 + 0.6 * ((t - 12.5) / 1.5));
  t += step;
}

// ---------------------------------------------------------------- pads: Em C G D
const CH = { Em: [52, 55, 59, 64], C: [48, 55, 60, 64], G: [50, 55, 59, 62], D: [50, 54, 57, 62], Em9: [52, 55, 59, 66] };
const prog = ["Em", "C", "G", "D"];
for (let bar = 0; bar < 10; bar++) {
  const t0 = bar * 2;
  const ch = CH[prog[bar % 4]];
  const intro = t0 < 4;
  const cut = (t) => (t < 4 ? 350 + 900 * (t / 4) ** 2 : t >= 12 && t < 14 ? 900 + 1200 * ((t - 12) / 2) : 2600);
  ch.forEach((note, k) => {
    for (const [det, pan] of [[-0.1, -0.6], [0.1, 0.6]]) {
      const f = svf();
      let ph = (k * 0.37 + det) % 1;
      const freq = midi(note) * Math.pow(2, det / 12);
      add(t0, 2.6, (x, i) => {
        ph += freq / SR;
        const saw = 2 * (ph % 1) - 1;
        const t = t0 + x;
        const env = Math.min(1, x / (intro && bar === 0 ? 1.2 : 0.05)) * (x > 2 ? Math.max(0, 1 - (x - 2) / 0.6) : 1);
        const s0 = at(t);
        const duck = inDrop(t) && s0 < N ? pump[s0] : 1;
        return f(saw, cut(t), 0.8).lp * env * duck;
      }, 0.04, pan, 0.45);
    }
  });
}
// Final chord under the end hit.
CH.Em9.forEach((note) => {
  const f = svf();
  let ph = 0;
  const freq = midi(note);
  add(20, 4, (x) => {
    ph += freq / SR;
    return f(2 * (ph % 1) - 1, 2400 * Math.exp(-x / 1.5) + 300, 0.8).lp * Math.exp(-x / 1.6);
  }, 0.05, 0, 0.6);
});

// ---------------------------------------------------------------- bass (off-beat 8ths in the drops)
const roots = { Em: 40, C: 36, G: 43, D: 38 };
for (let t = 4; t < 20; t += BEAT) {
  if (!inDrop(t)) continue;
  const root = roots[prog[Math.floor(t / 2) % 4]];
  const f = svf();
  let ph = 0;
  add(t + BEAT / 2, BEAT * 0.45, (x) => {
    ph += midi(root) / SR;
    const saw = 2 * (ph % 1) - 1;
    return (f(saw, 250 + 2000 * Math.exp(-x / 0.05), 1.3).lp * 0.8 + Math.sin(2 * Math.PI * ph) * 0.7) * Math.min(1, x / 0.004) * Math.exp(-x / 0.16);
  }, 0.4);
}
add(0, 4, (x) => Math.sin(2 * Math.PI * midi(28) * x) * Math.min(1, x / 2), 0.25);

// ---------------------------------------------------------------- arp lead (square, 16ths)
for (let t = 4; t < 20; t += BEAT / 4) {
  const drop2 = t >= 14;
  if (!inDrop(t) && !(t >= 12 && t < 14)) continue;
  const ch = CH[prog[Math.floor(t / 2) % 4]];
  const step = Math.round(t * 8) % 8;
  const note = ch[[0, 1, 2, 3, 2, 1, 3, 2][step]] + 12 + (drop2 && step % 4 === 3 ? 12 : 0);
  const f = svf();
  let ph = 0;
  const g = t >= 12 && t < 14 ? 0.5 : drop2 ? 1 : 0.8;
  add(t, BEAT / 4, (x, i) => {
    ph += midi(note) / SR;
    const sq = ph % 1 < 0.5 ? 1 : -1;
    const s0 = at(t) + i;
    return f(sq, drop2 ? 5200 : 3000, 1).lp * Math.exp(-x / 0.08) * (inDrop(t) && s0 < N ? 0.6 + 0.4 * pump[s0] : 1);
  }, 0.055 * g, step % 2 ? 0.35 : -0.35, 0.35);
}

// ---------------------------------------------------------------- risers, downlifter, impacts
function riser(t0, dur, g = 1) {
  const f = svf();
  let ph = 0;
  add(t0, dur, (x) => {
    const u = x / dur;
    ph += (180 * Math.pow(4, u)) / SR;
    return f(rnd(), 300 + 7500 * u * u, 2.5).bp * u * u + (2 * (ph % 1) - 1) * u * u * 0.08;
  }, 0.45 * g, 0, 0.4);
}
riser(2, 2);
riser(12.5, 1.5, 1.1);
{
  const f = svf();
  add(12, 1.5, (x) => f(rnd(), 300 + 6000 * (1 - x / 1.5) ** 1.5, 2).bp * (1 - x / 1.5) ** 1.5, 0.35, 0, 0.5);
}
function impact(t, g = 1) {
  let ph = 0;
  add(t, 3.5, (x) => {
    ph += (2 * Math.PI * (32 + 60 * Math.exp(-x / 0.22))) / SR;
    return Math.tanh(2 * Math.sin(ph)) * Math.exp(-x / 1);
  }, g * 0.7, 0, 0.3);
  const n = svf();
  add(t, 2, (x) => n(rnd(), 800 + 3000 * Math.exp(-x / 0.3), 0.7).lp * Math.exp(-x / 0.45), g * 0.6, 0, 0.8);
}
impact(4);
impact(14, 1.1);
impact(20, 1.2);
// Pre-drop gaps (the hit lands harder after a breath).
for (const t of [4, 14]) for (let i = at(t - 0.12); i < at(t); i++) {
  L[i] *= 0.08;
  R[i] *= 0.08;
}

// ---------------------------------------------------------------- reverb (Schroeder) and master
function reverb(src, spread) {
  const out = new Float32Array(N);
  const combs = [1557, 1617, 1491, 1422].map((d) => ({ buf: new Float32Array(d + spread), i: 0, lp: 0 }));
  const aps = [225, 556].map((d) => ({ buf: new Float32Array(d + spread), i: 0 }));
  for (let n = 0; n < N; n++) {
    let acc = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.lp = y * 0.75 + c.lp * 0.25;
      c.buf[c.i] = src[n] + c.lp * 0.84;
      c.i = (c.i + 1) % c.buf.length;
      acc += y;
    }
    let y = acc * 0.25;
    for (const a of aps) {
      const b = a.buf[a.i];
      const v = y + b * 0.5;
      a.buf[a.i] = v;
      a.i = (a.i + 1) % a.buf.length;
      y = b - v * 0.5;
    }
    out[n] = y;
  }
  return out;
}
const rl = reverb(verbL, 0);
const rr = reverb(verbR, 23);
let peak = 1e-9;
for (let i = 0; i < N; i++) {
  L[i] = Math.tanh((L[i] + rl[i] * 0.6) * 1.1);
  R[i] = Math.tanh((R[i] + rr[i] * 0.6) * 1.1);
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const out = process.argv[2] ?? "benchmark_score.wav";
const buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + N * 4, 4);
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
buf.writeUInt32LE(N * 4, 40);
const g = 0.93 / peak;
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * g)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * g)) * 32767), 46 + i * 4);
}
writeFileSync(out, buf);
console.log(`wrote ${out}`);
