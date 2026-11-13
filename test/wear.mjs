// Groove wear: play the same passage near the label 100 times and measure what it did to the sound.
// One pass at wear = 25 counts as 25 plays. A bright, loud passage (1 kHz + 9 kHz), inner groove.
import { makeRecord, play, spectrum, line, band, dB, CLEAN } from './lib.mjs';
const fs = 48000, fHi = 9000, fLo = 1000;
let fail = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fail++; };
const gen = (t) => 0.15 * Math.sin(2 * Math.PI * fLo * t) + 0.3 * Math.sin(2 * Math.PI * fHi * t);
const rec = makeRecord(gen, 6, fs, CLEAN);
for (let k = 0; k < rec.rTab.length; k++) rec.rTab[k] = Math.max(0.0532, rec.rTab[k] - 0.084);
const cart = (stylus, vtf) => (e) => e.set({ stylus, vtf });

function measure(setup, wear) {         // listen without wearing it any further
  const o = play(rec, { fs, seconds: 1, settle: 2, quiet: true, setup: (e) => { setup(e); e.p.wear = 0; if (wear) e.reader.wear = wear; } });
  const sp = spectrum(o.L, fs), hi = line(sp, fHi), lo = line(sp, fLo);
  const junk = Math.sqrt(Math.max(band(sp, 200, 20000) ** 2 - (hi * hi + lo * lo) / 2, 1e-30));   // distortion + noise
  return { hi: dB(hi), junk: dB(junk), o };
}
function age(setup, plays) {
  let wear = null;
  for (let k = 0; k < plays / 25; k++) {
    const o = play(rec, { fs, seconds: 1, settle: 2, quiet: true, setup: (e) => { setup(e); e.p.wear = 25; if (wear) e.reader.wear = wear; } });
    wear = o.e.reader.wear;
  }
  return wear;
}
const worn = {};
for (const [name, setup] of [['micro-line 1.8 g', cart('microline', 1.8)], ['elliptical 1.8 g', cart('elliptical', 1.8)],
  ['elliptical 3 g', cart('elliptical', 3)], ['conical 4 g', cart('conical', 4)]]) {
  const m0 = measure(setup), wear = age(setup, 100), m1 = measure(setup, wear);
  worn[name] = { wear, d: m1.hi - m0.hi };
  console.log(`${name.padEnd(17)} 100 plays: 9 kHz ${(m1.hi - m0.hi).toFixed(2).padStart(6)} dB, distortion + noise ${(m1.junk - m0.junk).toFixed(2).padStart(6)} dB (same stylus)`);
}
check(worn['micro-line 1.8 g'].d > -0.3, 'a micro-line at 1.8 g hardly wears the record');
check(worn['conical 4 g'].d < -1, 'a conical at 4 g wears the treble off');
check(worn['elliptical 3 g'].d < worn['elliptical 1.8 g'].d - 0.5, 'more tracking force, more wear');
// Reported, not asserted: the record worn by the conical, played with a micro-line instead.
const fine = cart('microline', 1.8), n0 = measure(fine), n1 = measure(fine, worn['conical 4 g'].wear);
console.log(`note worn by the conical at 4 g, played with a micro-line: 9 kHz ${(n1.hi - n0.hi).toFixed(2)} dB, distortion + noise ${(n1.junk - n0.junk).toFixed(1)} dB`);
{
  const o = play(rec, { fs, seconds: 0.5, settle: 1, quiet: true, setup: (e) => { cart('conical', 4)(e); e.p.wear = 0; } });
  check(o.e.reader.wear[0].size === 0 && o.e.reader.wear[1].size === 0, 'wear off leaves the record as pressed');
}
if (fail) process.exit(1);
