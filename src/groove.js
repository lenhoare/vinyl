// Stylus-tip / groove-wall geometry.
// A tip of radius rs cannot follow the wall exactly: its centre rides on the wall profile dilated by
// the tip's circle,  D(s) = max_u [ d(s+u) + sqrt(rs^2 - u^2) ] - rs.  This is the true source of
// tracing distortion, pinch effect and inner-groove treble loss (same wavelengths get shorter near
// the label because the vinyl moves slower there). D is evaluated lazily, per block, on a grid twice
// as fine as the cut, from an 8x band-limited reconstruction of the wall.
import { TAU, makePolyphase } from './dsp.js';
import { grooveRadius } from './geometry.js';

const UP = 8, UT = 32, BS = 1024, SLOTS = 32, DB = 2 * BS;
export const WEAR_BS = BS;   // wear is kept per block of BS cut samples, only where there is some

// Band-limited 8x reconstruction of the wall around cut sample t0 + UT/2 - 1 (small + hot on purpose:
// called per sample so the JIT optimises it once and keeps it).
function upsample(src, t0, n, up, fine, fo) {
  if (t0 >= 0 && t0 + UT <= n) {
    for (let p = 0; p < UP; p++) {
      let a = 0; const co = p * UT;
      for (let t = 0; t < UT; t++) a += up[co + t] * src[t0 + t];
      fine[fo + p] = a;
    }
  } else {
    for (let p = 0; p < UP; p++) {
      let a = 0; const co = p * UT;
      for (let t = 0; t < UT; t++) { const k = t0 + t; if (k >= 0 && k < n) a += up[co + t] * src[k]; }
      fine[fo + p] = a;
    }
  }
}

// Roll the tip over the reconstructed wall: highest point of (wall + tip circle), refined sub-sample.
// Also leaves where on the wall the tip touches (fine-grid offset) in rollK.
let rollK = 0;
function roll(fine, c, cap, M) {
  let best = -1, bk = 0;
  for (let k = -M; k <= M; k++) { const v = fine[c + k] + cap[k + M]; if (v > best) { best = v; bk = k; } }
  rollK = bk;
  if (bk > -M && bk < M) {
    const y0 = fine[c + bk - 1] + cap[bk - 1 + M], y2 = fine[c + bk + 1] + cap[bk + 1 + M];
    const den = y0 - 2 * best + y2;
    if (den < 0) best -= 0.125 * (y2 - y0) * (y2 - y0) / den;
  }
  return best;
}

export class GrooveReader {
  constructor() {
    this.up = makePolyphase(UT, UP, 1, 9);
    this.rec = null;
    this.rScan = 18e-6;
    this.tag = new Int32Array(SLOTS).fill(-1);
    this.blk = Array.from({ length: SLOTS }, () => new Float32Array(2 * DB));
    this.blkK = Array.from({ length: SLOTS }, () => new Int32Array(2 * DB));   // cut sample the tip touches
    this.blkP = Array.from({ length: SLOTS }, () => new Float32Array(2 * DB)); // contact pressure factor there
    this.tmp = new Float32Array(0);
    this.wear = [new Map(), new Map()];    // per wall: block -> Float32Array(BS) of material worn away (m)
    this.dirty = new Set(); this.worn = new Set(); this.lastB = -1; this.maxWear = 0;
    this.cb = [-1, -1]; this.cw = [null, null];   // the block each wall was last worn in
    this.fine = new Float32Array((BS + 80) * UP);
    this.cap = new Float32Array(601);
    this.computed = 0;
  }
  setRecord(rec) {
    this.rec = rec; this.tag.fill(-1);
    this.wear[0].clear(); this.wear[1].clear(); this.dirty.clear(); this.worn.clear(); this.lastB = -1; this.maxWear = 0; this.cb = [-1, -1];
  }
  setScan(r) { if (r !== this.rScan) { this.rScan = r; this.tag.fill(-1); } }

  // Copy dilated wall offsets D[j0 .. j0+len) (grid = 2 per cut sample) for both walls, and the cut
  // sample each wall is touched at.
  fill(j0, len, outIn, outOut, kIn, kOut, pIn, pOut) {
    const nD = this.rec ? 2 * this.rec.n : 0;
    let j = j0, o = 0;
    while (o < len) {
      if (j < 0 || j >= nD) { outIn[o] = 0; outOut[o] = 0; kIn[o] = -1; kOut[o] = -1; pIn[o] = 1; pOut[o] = 1; j++; o++; continue; }
      const b = Math.floor(j / DB), s = b & (SLOTS - 1), blk = this.blk[s], bk = this.blkK[s], bp = this.blkP[s];
      if (this.tag[s] !== b) { this.compute(b, blk, bk, bp); this.tag[s] = b; }
      const base = j - b * DB, cnt = Math.min(len - o, DB - base);
      for (let k = 0; k < cnt; k++) {
        outIn[o + k] = blk[base + k]; outOut[o + k] = blk[DB + base + k];
        kIn[o + k] = bk[base + k]; kOut[o + k] = bk[DB + base + k]; pIn[o + k] = bp[base + k]; pOut[o + k] = bp[DB + base + k];
      }
      j += cnt; o += cnt;
    }
  }

  // ---------- wear: material worn off a wall, kept apart from the pressing and taken off when it is read ----------
  addWear(wall, i, d) {
    if (i < 0 || !this.rec || i >= this.rec.n) return;
    const b = (i / BS) | 0;
    let w;
    if (b === this.cb[wall]) w = this.cw[wall];        // same block as last time: the common case, no lookups
    else {
      const m = this.wear[wall];
      w = m.get(b);
      if (!w) { w = new Float32Array(BS); m.set(b, w); }
      this.cb[wall] = b; this.cw[wall] = w;
      this.dirty.add(wall * 1e8 + b); this.worn.add(b);
      if (b !== this.lastB) {
        // re-read blocks the tip has moved on from (not the ones it is on, or they would be rebuilt every step);
        // the tip next reaches them a revolution later, so the wear is there when it does
        for (const bb of this.worn) if (bb < b - 1 || bb > b + 1) { this.forget(bb); this.worn.delete(bb); }
        this.lastB = b;
      }
    }
    const v = (w[i - b * BS] += d);
    if (v > this.maxWear) this.maxWear = v;
  }
  forget(b) { for (let x = b - 1; x <= b + 1; x++) { const s = x & (SLOTS - 1); if (this.tag[s] === x) this.tag[s] = -1; } }
  // [[wall, block, Float32Array], ...] worn since the last call (copies), for saving
  takeDirty() {
    const out = [];
    for (const k of this.dirty) { const wall = k >= 1e8 ? 1 : 0, b = k - wall * 1e8; out.push([wall, b, this.wear[wall].get(b).slice()]); }
    this.dirty.clear(); this.cb = [-1, -1]; return out;   // so the next wear marks its block dirty again
  }
  loadWear(blocks) {
    for (const [wall, b, w] of blocks) {
      this.wear[wall].set(b, Float32Array.from(w)); this.cb = [-1, -1];
      for (let i = 0; i < w.length; i++) if (w[i] > this.maxWear) this.maxWear = w[i];
    }
    this.tag.fill(-1);
  }
  clearWear() { this.wear[0].clear(); this.wear[1].clear(); this.dirty.clear(); this.worn.clear(); this.maxWear = 0; this.cb = [-1, -1]; this.tag.fill(-1); }

  compute(b, out, outK, outP) {
    const rec = this.rec, n = rec.n, up = this.up, i0 = b * BS;
    const r = grooveRadius(rec.rTab, (i0 + BS / 2) * TAU / rec.spr);
    const h = TAU * r / rec.spr / UP;                 // metres of groove per fine sample
    const rs = this.rScan, M = Math.min(300, Math.ceil(rs / h));
    const cap = this.cap, ih2 = 1 / (h * h);
    for (let k = -M; k <= M; k++) cap[k + M] = Math.sqrt(Math.max(0, rs * rs - k * h * k * h)) - rs;
    const m = Math.ceil(M / UP) + 2, ia = i0 - m, cnt = BS + 2 * m;
    if (this.fine.length < cnt * UP) this.fine = new Float32Array(cnt * UP);
    const fine = this.fine;
    for (let wall = 0; wall < 2; wall++) {
      const src = wall ? rec.wallOut : rec.wallIn, wm = this.wear[wall];
      const lo = ia - UT / 2 + 1, len = cnt + UT, b0 = Math.floor(lo / BS), b1 = Math.floor((lo + len - 1) / BS);
      let worn = false;
      for (let x = b0; x <= b1 && !worn; x++) worn = wm.has(x);
      if (worn) {                                   // the wall as it is now: pressing minus wear
        if (this.tmp.length < len) this.tmp = new Float32Array(len);
        const tmp = this.tmp;
        for (let k = 0; k < len; k++) {
          const i = lo + k;
          if (i < 0 || i >= n) { tmp[k] = 0; continue; }
          const w = wm.get((i / BS) | 0);
          tmp[k] = w ? src[i] - w[i % BS] : src[i];
        }
        for (let q = 0; q < cnt; q++) upsample(tmp, q, len, up, fine, q * UP);
      } else for (let q = 0; q < cnt; q++) upsample(src, ia + q - UT / 2 + 1, n, up, fine, q * UP);
      const oo = wall * DB;
      for (let jj = 0; jj < DB; jj++) {
        out[oo + jj] = roll(fine, (m + (jj >> 1)) * UP + (jj & 1) * (UP / 2), cap, M);
        outK[oo + jj] = Math.round(i0 + jj / 2 + rollK / UP);   // where on the wall the tip touches
        // Hertz: a crest that curves toward the tip shrinks the contact along the groove, 1/Rx = 1/rs + kappa,
        // and the peak pressure goes as (rs / Rx)^(1/3) for the same force
        const fc = (m + (jj >> 1)) * UP + (jj & 1) * (UP / 2) + rollK;
        const kap = -(fine[fc - 1] - 2 * fine[fc] + fine[fc + 1]) * ih2;
        outP[oo + jj] = kap > 0 ? Math.cbrt(1 + rs * kap) : 1;
      }
    }
    this.computed++;
  }
}
