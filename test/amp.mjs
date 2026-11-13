// The valve amplifier on its own: harmonic signature vs warmth, level, tone controls, bypass.
import { Amp } from '../src/amp.js';
import { spectrum, line, dB } from './lib.mjs';
const fs = 48000, n = 65536, f0 = 1000 * 32768 / fs | 0, F = f0 * fs / 32768;   // bin-centred tone
let fail = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fail++; };

function run(opts, gen) {
  const a = new Amp(fs); a.set(opts);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = R[i] = gen(i / fs);
  for (let o = 0; o < n; o += 128) a.process(L.subarray(o, o + 128), R.subarray(o, o + 128), 128);
  return spectrum(L.subarray(n - 32768), fs);
}
const sine = (A, f = F) => (t) => A * Math.sin(TAU * f * t);
const TAU = 2 * Math.PI;

console.log('warmth  level   H1 dB   H2 dB   H3 dB   H5 dB');
for (const w of [0, 0.35, 0.7, 1]) for (const A of [0.1, 0.5, 0.9]) {
  const sp = run({ warmth: w }, sine(A)), h1 = line(sp, F);
  const h = [2, 3, 5].map((k) => dB(line(sp, k * F) / h1).toFixed(1).padStart(7));
  console.log(w.toFixed(2).padStart(6), A.toFixed(1).padStart(6), dB(h1 / A).toFixed(2).padStart(7), h.join(' '));
}
{
  const sp = run({ warmth: 0.35 }, sine(0.5)), h1 = line(sp, F);
  check(Math.abs(dB(h1 / 0.5)) < 1, 'gain is made up: 1 kHz within 1 dB of unity at the default warmth');
  check(dB(line(sp, 2 * F) / h1) > -60, 'preamp adds audible 2nd harmonic at the default warmth');
  check(dB(line(sp, 2 * F) / h1) < -20, '... but stays tasteful (< 10%) on a loud tone');
  const q = run({ warmth: 0.35 }, sine(0.05)), q1 = line(q, F);
  check(dB(line(q, 3 * F) / q1) < -60, 'quiet passages are clean (3rd harmonic < 0.1%)');
  const off = run({ valve: false }, sine(0.9)), o1 = line(off, F);
  check(dB(line(off, 2 * F) / o1) < -100 && Math.abs(dB(o1 / 0.9)) < 0.01, 'solid state bypass is perfectly clean');
  const hot = run({ warmth: 1 }, sine(0.9));
  // aliasing: 0.9 at 7.3 kHz; harmonics above Nyquist fold back to non-harmonic bins
  const fa = 7300 * 32768 / fs | 0, FA = fa * fs / 32768, al = run({ warmth: 1 }, sine(0.9, FA)), a1 = line(al, FA);
  const alias = line(al, fs - 4 * FA, 0.002);   // 4th harmonic (29.2 kHz) folds to 18.8 kHz
  check(dB(alias / a1) < -50, `antialiasing: folded 4th harmonic at ${dB(alias / a1).toFixed(1)} dB`);
  check(line(hot, F) <= 0.9, 'never louder than the input (soft saturation, no overshoot)');
}
for (const [k, f] of [['bass', 40], ['treble', 15000]]) for (const g of [-6, 6]) {
  const ff = Math.round(f * 32768 / fs) * fs / 32768, sp = run({ valve: false, [k]: g }, sine(0.1, ff));
  const got = dB(line(sp, ff) / 0.1);
  check(Math.abs(got - g) < 1.5, `${k} ${g > 0 ? '+' : ''}${g} dB at ${f} Hz: ${got.toFixed(1)} dB`);
}
const mid = run({ valve: false, bass: 6, treble: 6 }, sine(0.1));
check(Math.abs(dB(line(mid, F) / 0.1)) < 1.5, `tone controls leave 1 kHz alone: ${dB(line(mid, F) / 0.1).toFixed(2)} dB`);
if (fail) { console.log(fail + ' failed'); process.exit(1); }
