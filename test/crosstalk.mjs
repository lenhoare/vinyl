// Channel separation: cut the left channel only (bass not mono'd), measure what the right coil picks up.
// Azimuth sets a flat floor (~ -34 dB); the armature cross-coupling takes over above a few kHz.
import { makeRecord, play, spectrum, line, dB, CLEAN } from './lib.mjs';
const fs = 48000, want = { 1000: [-40, -26], 10000: [-22, -12] };
let fail = 0;
for (const f of [100, 1000, 5000, 10000]) {
  const rec = makeRecord((t) => [0.1 * Math.sin(2 * Math.PI * f * t), 0], 8, fs, CLEAN, { ellipticalHz: 0 });
  const o = play(rec, { fs, seconds: 1, settle: 3, quiet: true });
  const x = dB(line(spectrum(o.R, fs), f) / line(spectrum(o.L, fs), f)), w = want[f];
  const ok = !w || (x > w[0] && x < w[1]); if (!ok) fail++;
  console.log((ok ? 'ok   ' : 'FAIL ') + `L->R crosstalk at ${f} Hz: ${x.toFixed(1)} dB` + (w ? ` (want ${w[0]}..${w[1]})` : ''));
}
if (fail) process.exit(1);
