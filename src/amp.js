// The amplifier after the phono stage: a tone stack, a valve preamp and a push-pull valve power amp
// with its power supply and output transformer. Runs at the output rate, after the engine, in place.
//
//   tone stack     Baxandall-style bass and treble shelves (+-12 dB)
//   preamp         one 12AX7 triode stage: a biased tanh, so it bends one half of the wave more than
//                  the other. That asymmetry is the even (2nd) harmonic valve preamps are loved for.
//                  The coupling capacitor after it blocks the DC the asymmetry creates.
//   power amp      a push-pull EL34 pair: the two halves cancel the even harmonics and the stage
//                  saturates symmetrically (3rd harmonic) and softly, never a hard clip.
//   supply sag     loud passages draw the HT rail down, so headroom shrinks for a moment and the
//                  amp compresses gently, then recovers (rectifier + reservoir capacitor).
//   transformer    the output transformer limits the band: a gentle roll-off below ~15 Hz and above ~22 kHz.
//
// The nonlinear stages use first-order antiderivative antialiasing (ADAA), so the harmonics they make
// don't fold back below Nyquist as inharmonic grit. `warmth` sets how hard both stages are driven;
// gain is made up afterwards, so it changes the character, not the loudness.
import { TAU } from './dsp.js';

const LN2 = Math.LN2;
const logcosh = (z) => { const a = Math.abs(z); return a + Math.log1p(Math.exp(-2 * a)) - LN2; };

// RBJ shelving biquad, [b0, b1, b2, a1, a2]
function shelf(fs, f0, dB, high) {
  const A = 10 ** (dB / 40), w = TAU * f0 / fs, c = Math.cos(w), s = Math.sin(w);
  const al = s / 2 * Math.SQRT2 * 0.85, sq = 2 * Math.sqrt(A) * al, sg = high ? -1 : 1;
  const b0 = A * ((A + 1) - sg * (A - 1) * c + sq), b1 = sg * 2 * A * ((A - 1) - sg * (A + 1) * c), b2 = A * ((A + 1) - sg * (A - 1) * c - sq);
  const a0 = (A + 1) + sg * (A - 1) * c + sq, a1 = -sg * 2 * ((A - 1) + sg * (A + 1) * c), a2 = (A + 1) + sg * (A - 1) * c - sq;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

const B = 0.4, TB = Math.tanh(B), SB = 1 - TB * TB;            // triode bias point and the slope there
const tri = (u) => (Math.tanh(u + B) - TB) / SB;                // unity slope at rest, 0 at rest
const triF = (u) => (logcosh(u + B) - u * TB) / SB;             // its antiderivative

class Channel {
  constructor() { this.z = new Float64Array(4); this.u1 = 0; this.F1 = 0; this.dcX = 0; this.dcY = 0; this.v1 = 0; this.G1 = 0; this.hp = 0; this.hpX = 0; this.lp = 0; this.env = 0; }
}

export class Amp {
  constructor(fs) {
    this.fs = fs;
    this.ch = [new Channel(), new Channel()];
    this.kDC = Math.exp(-TAU * 8 / fs);                         // preamp coupling capacitor
    this.kOT = Math.exp(-TAU * 15 / fs);                        // transformer low end
    this.kLP = 1 - Math.exp(-TAU * Math.min(22000, 0.45 * fs) / fs);   // transformer top end
    this.kAtt = 1 - Math.exp(-1 / (0.008 * fs)); this.kRel = 1 - Math.exp(-1 / (0.18 * fs));   // supply sag
    this.p = { valve: true, warmth: 0.35, bass: 0, treble: 0 };
    this.set({});
  }
  set(o) {
    for (const k of ['valve', 'warmth', 'bass', 'treble']) if (o[k] != null) this.p[k] = o[k];
    const p = this.p;
    this.lo = shelf(this.fs, 120, p.bass, false);
    this.hi = shelf(this.fs, 5000, p.treble, true);
    this.flat = p.bass === 0 && p.treble === 0;
    this.gPre = Math.max(1e-3, 0.9 * p.warmth);                 // drive into the triode
    this.gPow = 0.25 + 0.6 * p.warmth;                          // drive into the output pair
    this.sag = 0.3 * p.warmth;
  }

  process(L, R, n) {
    const valve = this.p.valve, flat = this.flat, kAtt = this.kAtt, kRel = this.kRel;
    const [lb0, lb1, lb2, la1, la2] = this.lo, [hb0, hb1, hb2, ha1, ha2] = this.hi;
    const gPre = this.gPre, gPow = this.gPow, sag = this.sag, kDC = this.kDC, kOT = this.kOT, kLP = this.kLP;
    for (let c = 0; c < 2; c++) {
      const x = c ? R : L, s = this.ch[c], z = s.z;
      if (!x) continue;
      let z0 = z[0], z1 = z[1], z2 = z[2], z3 = z[3], u1 = s.u1, F1 = s.F1, dcX = s.dcX, dcY = s.dcY;
      let v1 = s.v1, G1 = s.G1, hp = s.hp, hpX = s.hpX, lp = s.lp, e = s.env;
      for (let i = 0; i < n; i++) {
        let y = x[i];
        if (!flat) {                                            // tone stack
          let t = lb0 * y + z0; z0 = lb1 * y - la1 * t + z1; z1 = lb2 * y - la2 * t; y = t;
          t = hb0 * y + z2; z2 = hb1 * y - ha1 * t + z3; z3 = hb2 * y - ha2 * t; y = t;
        }
        if (valve) {
          // preamp triode (ADAA), then the coupling capacitor
          const u = y * gPre, F = triF(u), du = u - u1;
          const a = Math.abs(du) > 1e-6 ? (F - F1) / du : tri(0.5 * (u + u1));
          u1 = u; F1 = F;
          dcY = kDC * (dcY + a - dcX); dcX = a; y = dcY / gPre;
          // power stage: headroom h shrinks while the supply sags
          const h = 1 - sag * (e < 1 ? e : 1), v = y * gPow / h, G = logcosh(v), dv = v - v1;
          let o = Math.abs(dv) > 1e-6 ? (G - G1) / dv : Math.tanh(0.5 * (v + v1));
          v1 = v; G1 = G;
          o *= h / gPow;
          const ao = o < 0 ? -o : o; e += (ao > e ? kAtt : kRel) * (ao - e);
          // output transformer
          hp = kOT * (hp + o - hpX); hpX = o;
          lp += kLP * (hp - lp); y = lp;
        }
        x[i] = y;
      }
      z[0] = z0; z[1] = z1; z[2] = z2; z[3] = z3; s.u1 = u1; s.F1 = F1; s.dcX = dcX; s.dcY = dcY;
      s.v1 = v1; s.G1 = G1; s.hp = hp; s.hpX = hpX; s.lp = lp;
      s.env = e;
    }
  }
}
