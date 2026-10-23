// Original soundtrack for the Mantagli promo: 20 s, 120 BPM, A minor, 48 kHz stereo WAV.
// Intro (0–4 s) · build + riser (4–8 s) · drop (8–16 s) · end hit + tail (16–20 s).
// Usage: node scripts/promo/score.mjs <out.wav>
import { writeFileSync } from "node:fs";

const SR = 48000;
const LEN = 20;
const N = SR * LEN;
const L = new Float32Array(N);
const R = new Float32Array(N);
const verbL = new Float32Array(N); // reverb sends
const verbR = new Float32Array(N);
const BEAT = 0.5;
const BAR = 2;

let seed = 1234567;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const at = (t) => Math.floor(t * SR);

/** State-variable filter. */
function svf() {
  let lp = 0, bp = 0;
  return (x, fc, q = 0.7) => {
    const f = 2 * Math.sin((Math.PI * Math.min(fc, SR / 6)) / SR);
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

// ---------------------------------------------------------------- sidechain (kick pump), built first
const pump = new Float32Array(N).fill(1);
const kicks = [];
for (let t = 4; t < 8; t += BEAT) if (t >= 6 || Math.round(t * 2) % 2 === 0) kicks.push([t, t < 6 ? 0.55 : 0.75]);
for (let t = 8; t < 16; t += BEAT) kicks.push([t, 1]);
for (const [t, g] of kicks) {
  const s0 = at(t);
  for (let i = 0; i < at(0.45) && s0 + i < N; i++) pump[s0 + i] = Math.min(pump[s0 + i], 1 - g * 0.6 * Math.exp(-i / SR / 0.12));
}

// ---------------------------------------------------------------- drums
function kick(t, g = 1) {
  let ph = 0;
  add(t, 0.6, (x) => {
    const f = 45 + 110 * Math.exp(-x / 0.035);
    ph += (2 * Math.PI * f) / SR;
    const click = x < 0.004 ? rnd() * (1 - x / 0.004) * 0.5 : 0;
    return Math.tanh(1.6 * Math.sin(ph) * Math.exp(-x / 0.32)) * 0.9 + click;
  }, g * 0.95);
}
function clap(t, g = 1) {
  const f = svf();
  add(t, 0.4, (x) => {
    const env = Math.exp(-x / 0.12) * (x < 0.03 ? 0.6 + 0.4 * Math.abs(Math.sin(x * 500)) : 1);
    return f(rnd(), 1800, 0.9).bp * env * 2.2 + Math.sin(2 * Math.PI * 190 * x) * Math.exp(-x / 0.05) * 0.4;
  }, g * 0.55, 0.05, 0.35);
}
function hat(t, g = 1, open = false) {
  const f = svf();
  add(t, open ? 0.25 : 0.06, (x) => f(rnd(), 9000, 0.8).hp * Math.exp(-x / (open ? 0.08 : 0.018)), g * 0.22, 0.25);
}
function tick(t, g = 1) {
  add(t, 0.03, (x) => Math.sin(2 * Math.PI * 2400 * x) * Math.exp(-x / 0.006), g * 0.18, -0.3, 0.5);
}

for (const [t, g] of kicks) kick(t, g);
for (let t = 0; t < 4; t += BEAT) tick(t, 0.6 + 0.4 * (t / 4));
for (let t = 8; t < 16; t += BEAT * 2) clap(t + BEAT);
for (let t = 8; t < 16; t += BEAT / 4) hat(t, Math.round(t * 8) % 2 ? 0.6 : 1);
for (let t = 8 + BEAT / 2; t < 16; t += BEAT) hat(t, 0.5, true);
for (let t = 4; t < 6; t += BEAT / 2) hat(t, 0.6);
// Snare roll into the drop: 8ths → 16ths → 32nds, crescendo.
for (let t = 6; t < 7.875; ) {
  const step = t < 6.75 ? BEAT / 2 : t < 7.5 ? BEAT / 4 : BEAT / 8;
  clap(t, 0.25 + 0.55 * ((t - 6) / 2));
  t += step;
}

// ---------------------------------------------------------------- pads (Am F C G progression)
const CHORDS = {
  Am: [57, 60, 64, 69],
  Am9: [57, 60, 64, 71],
  F: [53, 57, 60, 65],
  C: [55, 60, 64, 67],
  G: [55, 59, 62, 67],
};
const padPlan = [
  [0, 4, "Am", 400, 900],
  [4, 2, "F", 900, 2200],
  [6, 2, "G", 1500, 4000],
  [8, 2, "Am", 2400, 2400],
  [10, 2, "F", 2400, 2400],
  [12, 2, "C", 2400, 2400],
  [14, 2, "G", 2400, 3200],
  [16, 4, "Am9", 2600, 500],
];
for (const [t0, dur, ch, c0, c1] of padPlan) {
  CHORDS[ch].forEach((note, k) => {
    for (const [det, pan] of [[-0.11, -0.7], [0.0, 0], [0.12, 0.7]]) {
      const f = svf();
      let ph = Math.random();
      const freq = midi(note) * Math.pow(2, det / 12);
      add(t0, dur + 1.2, (x, i) => {
        ph += freq / SR;
        const saw = 2 * (ph % 1) - 1;
        const u = Math.min(1, x / dur);
        const cutoff = c0 + (c1 - c0) * u;
        const attack = Math.min(1, x / (t0 === 0 ? 1.5 : 0.08));
        const release = x > dur ? Math.max(0, 1 - (x - dur) / 1.2) : 1;
        const s0 = at(t0) + i;
        const duck = t0 >= 8 && t0 < 16 && s0 < N ? pump[s0] : 1;
        return f(saw, cutoff, 0.9).lp * attack * release * duck;
      }, 0.045 * (k === 0 ? 1.2 : 1), pan, 0.5);
    }
  });
}

// ---------------------------------------------------------------- bass
// Intro/outro sub drone; pumping off-beat bass in the drop.
add(0, 8, (x) => Math.sin(2 * Math.PI * midi(33) * x) * Math.min(1, x / 2) * (x > 7.8 ? Math.max(0, (8 - x) / 0.2) : 1), 0.32);
const roots = [45, 41, 48, 43];
for (let b = 0; b < 4; b++) {
  for (let e = 0; e < 4; e++) {
    const t = 8 + b * BAR + e * BEAT + BEAT / 2;
    const f = svf();
    let ph = 0;
    const freq = midi(roots[b]);
    add(t, BEAT * 0.48, (x) => {
      ph += freq / SR;
      const saw = 2 * (ph % 1) - 1;
      return (f(saw, 300 + 2200 * Math.exp(-x / 0.06), 1.4).lp * 0.8 + Math.sin(2 * Math.PI * ph) * 0.6) * Math.min(1, x / 0.004) * Math.exp(-x / 0.18);
    }, 0.42);
  }
}
add(16, 4, (x) => Math.sin(2 * Math.PI * midi(33) * x) * Math.exp(-x / 2.2), 0.4);

// ---------------------------------------------------------------- riser, reverse swell, impacts
{
  const f = svf();
  add(4, 3.9, (x) => {
    const u = x / 3.9;
    return f(rnd(), 400 + 7000 * u * u, 3).bp * u * u * 0.9 + Math.sin(2 * Math.PI * (200 * x + 450 * x * x * u)) * u * u * 0.12;
  }, 0.5, 0, 0.4);
}
{
  const f = svf();
  add(15, 0.95, (x) => f(rnd(), 1500 + 6000 * x, 1).hp * Math.pow(x / 0.95, 3), 0.35, 0, 0.3);
}
function impact(t, g = 1) {
  let ph = 0;
  add(t, 3.5, (x) => {
    const f = 30 + 70 * Math.exp(-x / 0.25);
    ph += (2 * Math.PI * f) / SR;
    return Math.tanh(2 * Math.sin(ph)) * Math.exp(-x / 1.1);
  }, g * 0.75, 0, 0.3);
  const n = svf();
  add(t, 2.5, (x) => n(rnd(), 900 + 3000 * Math.exp(-x / 0.3), 0.7).lp * Math.exp(-x / 0.5), g * 0.7, 0, 0.8);
}
impact(8, 1);
impact(16, 1.1);
// Pre-drop silence: cut everything in the last 1/16 before 8.0 s.
for (let i = at(7.9); i < at(8); i++) {
  L[i] *= 0.05;
  R[i] *= 0.05;
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
      a.buf[a.i] = y + b * 0.5;
      y = b - y * 0.5;
      a.i = (a.i + 1) % a.buf.length;
    }
    out[n] = y;
  }
  return out;
}
const rvL = reverb(verbL, 0);
const rvR = reverb(verbR, 23);
let peak = 0;
for (let i = 0; i < N; i++) {
  const fadeOut = i > at(19) ? Math.max(0, (N - i) / at(1)) : 1;
  L[i] = Math.tanh((L[i] + rvL[i] * 0.45) * 1.1) * fadeOut;
  R[i] = Math.tanh((R[i] + rvR[i] * 0.45) * 1.1) * fadeOut;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const norm = 0.89 / peak; // −1 dBFS
const buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + N * 4, 4);
buf.write("WAVEfmt ", 8);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * norm)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * norm)) * 32767), 46 + i * 4);
}
writeFileSync(process.argv[2] ?? "score.wav", buf);
console.log(`wrote ${process.argv[2]} (${LEN} s, peak normalised to −1 dBFS)`);
