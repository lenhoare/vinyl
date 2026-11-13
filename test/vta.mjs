// Vertical tracking angle: a stylus that moves along a different angle from the cutter's reads the vertical
// part of the modulation early or late, by height * (tan a - tan b). Mostly 2nd harmonic, worse near the label.
// Matched (20 deg) must be as clean as before; a lateral (mono) cut must not care.
import { makeRecord, play, spectrum, line, dB, CLEAN } from './lib.mjs';
const fs = 48000, f = 3000, A = 0.4;
let fail = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fail++; };
function h2(vta, { inner = false, mono = false } = {}) {
  const rec = makeRecord((t) => { const v = A * Math.sin(2 * Math.PI * f * t); return mono ? v : [v, 0]; }, 8, fs, CLEAN, { ellipticalHz: 0 });
  if (inner) for (let k = 0; k < rec.rTab.length; k++) rec.rTab[k] = Math.max(0.0532, rec.rTab[k] - 0.084);
  const o = play(rec, { fs, seconds: 1, settle: 3, quiet: true, setup: (e) => e.set({ vta, stylus: 'microline' }) });
  const sp = spectrum(o.L, fs); return dB(line(sp, 2 * f) / line(sp, f));
}
const res = {};
for (const inner of [false, true]) for (const v of [10, 15, 20, 25, 30]) {
  const x = h2(v, { inner }); res[(inner ? 'i' : 'o') + v] = x;
  console.log(`${inner ? 'inner' : 'outer'} VTA ${v} deg: H2 ${x.toFixed(1)} dB`);
}
check(res.o30 > res.o20 + 3 && res.o10 > res.o20 + 3, 'a 10 deg mismatch either way adds 2nd harmonic on top of tracing distortion');
check(res.o25 < res.o30 && res.o15 < res.o10, 'more mismatch, more distortion');
check(res.i30 > res.o30, 'worse near the label');
const m20 = h2(20, { mono: true }), m30 = h2(30, { mono: true });
check(Math.abs(m30 - m20) < 1, `a lateral (mono) cut is unaffected: ${m20.toFixed(1)} vs ${m30.toFixed(1)} dB`);
if (fail) process.exit(1);
