'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   SIGIL DSP CORE v1
   --------------------------------------------------------------------------
   Plain JavaScript DSP. No Web Audio, no DOM, no imports, so the same file can
   be loaded by the page (to build wavetables), by an AudioWorklet (to play),
   and later by a Worker (to render offline). Identical code means identical
   output in all three.

   THE SPLIT
     The host does the musical thinking. It resolves every event's pitch,
     duration, velocity, vowel, consonant class and drum root before sending
     them, and it builds the band-limited wavetables. The core only makes sound.

   THE PLAN the host sends
     { sr, spb, total, loop, sections:[{start, P}], events:[…], tables:{key:[…]} }
     event: { t, kind, bus, f, f0, dur, vel, pan, vow, cons, open, cell }

   DETERMINISM  all noise comes from a per-voice integer PRNG seeded from the
     event's musical identity, so a render equals a performance, sample for sample.
   ══════════════════════════════════════════════════════════════════════════ */

var SigilDSP = (function () {
  const TAU = Math.PI * 2;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  /** Small, fast, seedable PRNG. Same one the node engine used, so noise matches. */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ── Wavetables ────────────────────────────────────────────────────────
     Built on the host, never on the audio thread. Each cell becomes a ladder
     of band-limited tables; the voice picks the one whose top partial stays
     under Nyquist for the note it is playing. */
  const TLEN = 1024;
  const TIERS = [32, 12, 6, 2];

  /** @returns {Float32Array[]} one table per tier, each TLEN+1 long (wrapped). */
  function buildTables(re, im) {
    const out = [];
    for (const maxH of TIERS) {
      const t = new Float32Array(TLEN + 1);
      const top = Math.min(maxH, re.length - 1);
      for (let h = 1; h <= top; h++) {
        const s = im[h], c = re[h];
        if (!s && !c) continue;
        const step = (TAU * h) / TLEN;
        for (let i = 0; i < TLEN; i++) t[i] += s * Math.sin(step * i) + c * Math.cos(step * i);
      }
      let mx = 1e-9;
      for (let i = 0; i < TLEN; i++) if (Math.abs(t[i]) > mx) mx = Math.abs(t[i]);
      for (let i = 0; i < TLEN; i++) t[i] /= mx;
      t[TLEN] = t[0];
      out.push(t);
    }
    return out;
  }

  /* ── Filters ──────────────────────────────────────────────────────────
     Topology-preserving state variable filter: stable under fast modulation,
     cheap, and gives low, band and high pass from the same state. */
  class SVF {
    constructor() { this.ic1 = 0; this.ic2 = 0; this.g = 0.1; this.k = 1; this.a1 = 0; this.a2 = 0; this.a3 = 0; }
    set(sr, fc, q) {
      this.g = Math.tan((Math.PI * clamp(fc, 15, sr * 0.45)) / sr);
      this.k = 1 / Math.max(0.25, q);
      this.a1 = 1 / (1 + this.g * (this.g + this.k));
      this.a2 = this.g * this.a1;
      this.a3 = this.g * this.a2;
    }
    run(v) {
      const v3 = v - this.ic2;
      const v1 = this.a1 * this.ic1 + this.a2 * v3;
      const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
      this.ic1 = 2 * v1 - this.ic1;
      this.ic2 = 2 * v2 - this.ic2;
      this.lp = v2; this.bp = v1; this.hp = v - this.k * v1 - v2;
      return v2;
    }
  }

  /** One-pole lowpass, for damping and smoothing. */
  class OnePole {
    constructor(c) { this.z = 0; this.c = c || 0.2; }
    run(v) { this.z += this.c * (v - this.z); return this.z; }
  }

  /* ── Envelope ─────────────────────────────────────────────────────────
     Linear attack, exponential decay to sustain, exponential release. */
  class Env {
    constructor() { this.v = 0; this.stage = 0; this.done = true; }
    start(sr, a, d, s, r, peak) {
      this.peak = peak; this.s = s * peak;
      this.aInc = peak / Math.max(1, a * sr);
      this.dC = 1 - Math.exp(-1 / Math.max(1, d * sr * 0.4));
      this.rC = 1 - Math.exp(-1 / Math.max(1, r * sr * 0.4));
      this.v = 0; this.stage = 1; this.done = false;
    }
    release() { if (this.stage < 3) this.stage = 3; }
    run() {
      if (this.stage === 1) { this.v += this.aInc; if (this.v >= this.peak) { this.v = this.peak; this.stage = 2; } }
      else if (this.stage === 2) this.v += this.dC * (this.s - this.v);
      else { this.v += this.rC * (0 - this.v); if (this.v < 1e-4) { this.v = 0; this.done = true; } }
      return this.v;
    }
  }

  /* ── Voice ────────────────────────────────────────────────────────────
     One class, one render method per kind. Voices write mono into a bus pair
     with a constant pan, which keeps the inner loops tight. */
  class Voice {
    constructor() { this.done = true; }

    init(eng, ev, P) {
      const sr = eng.sr;
      this.eng = eng; this.kind = ev.kind; this.bus = ev.bus || 'lead';
      this.P = P; this.ev = ev;
      this.vel = ev.vel; this.pan = ev.pan || 0;
      this.rnd = rng(((ev.t * 96000) | 0) ^ ((ev.f * 131) | 0) ^ 0x5eed);
      this.dur = ev.dur || 0.25;
      this.relAt = Math.round(this.dur * sr);
      this.age = 0; this.done = false;
      this.env = this.env || new Env();
      this.f = ev.f;
      this.p1 = 0; this.p2 = 0; this.pSub = 0; this.pMod = 0;
      this.glide = ev.f0 ? ev.f0 / ev.f : 1;
      this.filt = this.filt || new SVF();
      this.filt2 = this.filt2 || new SVF();
      this.bp = this.bp || [new SVF(), new SVF(), new SVF(), new SVF()];

      switch (this.kind) {
        case 'wave': case 'bow': case 'fm': case 'bell': case 'vox': case 'drone': this.initPitched(); break;
        default: this.initDrum(); break;
      }
    }

    initPitched() {
      const eng = this.eng, P = this.P, sr = eng.sr;
      this.t0 = eng.table(this.ev.cell0, this.f);
      this.t1 = eng.table(this.ev.cell1, this.f);
      this.xf = 0;
      this.xfInc = this.dur > 0 ? 1 / Math.max(1, this.dur * sr) : 0;
      this.sub = P.sub || 0;
      const cut = this.f * (1.5 + 9 * (P.bright ?? 0.6));
      this.cut = cut; this.cutNow = cut;
      this.cutC = 1 - Math.exp(-1 / Math.max(1, 0.3 * this.dur * sr));
      this.filt.set(sr, cut, 0.7);

      if (this.kind === 'vox') {
        this.vow = this.ev.vow || [[800, 1150, 2900, 3900], [1, 0.5, 0.25, 0.12]];
        this.vowTo = this.ev.vowTo || this.vow;
        this.morph = 0;
        this.morphInc = 1 / Math.max(1, Math.min(this.dur * 0.9, 0.7) * sr);
        this.consLeft = Math.round((this.ev.cons === 2 ? 0.09 : 0.022) * sr);
        this.consType = this.ev.cons || 0;         // 0 none, 1 plosive, 2 fricative, 3 nasal
        for (let i = 0; i < 4; i++) this.bp[i].set(sr, this.vow[0][i], 7 + 7 * (this.P.bright ?? 0.6));
      }
      if (this.kind === 'fm') {
        this.ratio = 1 + (Math.round(this.P.wave || 0) % 5) + (Math.round(this.P.layer || 0) % 2) * 0.5;
        this.index = this.f * (0.6 + 3.4 * (this.P.bright ?? 0.6)) * this.vel;
        this.indexC = 1 - Math.exp(-1 / Math.max(1, (0.06 + 0.3 * this.dur) * sr));
      }
      if (this.kind === 'bell') {
        this.ring = Math.max(this.dur * 1.6, 1.1);
        this.parts = [[1, 0.5, this.ring * 0.45], [2.76, 0.22, this.ring * 0.3], [3.01, 0.1, this.ring * 0.18]];
        this.pp = [0, 0, 0];
        this.pv = [1, 1, 1];
        this.pc = this.parts.map((p) => 1 - Math.exp(-1 / Math.max(1, p[2] * this.eng.sr * 0.4)));
      }
      const a = this.kind === 'bow' ? 0.12 : this.kind === 'vox' ? 0.05 : 0.012;
      const peak = this.vel * (this.kind === 'vox' ? 0.42 : this.kind === 'bell' ? 0.5 : 0.32);
      this.env.start(this.eng.sr, a, 0.25, this.kind === 'bow' ? 0.9 : 0.78, 0.25, peak);
    }

    initDrum() {
      const sr = this.eng.sr, P = this.P, k = this.ev;
      this.f = k.f;
      this.decay = k.decay || 0.25;
      this.dC = 1 - Math.exp(-1 / Math.max(1, this.decay * sr * 0.35));
      this.lvl = this.vel;
      this.pitchEnv = 1;
      this.pc2 = 1 - Math.exp(-1 / Math.max(1, (k.pitchT || 0.04) * sr));
      this.nLvl = 1;
      this.nC = 1 - Math.exp(-1 / Math.max(1, (k.nDecay || 0.01) * sr * 0.35));
      if (this.kind === 'hat' || this.kind === 'perc') {
        this.filt.set(sr, k.hp || 7000, 0.7);
        this.filt2.set(sr, k.bp2 || 9000, 1.1);
      }
      if (this.kind === 'snare') {
        this.filt.set(sr, k.bpF || 1600, 0.7);
        this.filt2.set(sr, 5200, 0.6);
      }
      this.env.start(sr, 0.001, this.decay, 0.0001, this.decay, this.vel);
    }

    /** Render n samples into the bus pair. Returns false when finished. */
    run(L, R, n) {
      const g = this.gainL === undefined ? 0 : 0;
      const pl = Math.cos((this.pan + 1) * Math.PI / 4), pr = Math.sin((this.pan + 1) * Math.PI / 4);
      switch (this.kind) {
        case 'wave': this.rWave(L, R, n, pl, pr); break;
        case 'bow': this.rBow(L, R, n, pl, pr); break;
        case 'fm': this.rFm(L, R, n, pl, pr); break;
        case 'bell': this.rBell(L, R, n, pl, pr); break;
        case 'vox': this.rVox(L, R, n, pl, pr); break;
        case 'drone': this.rDrone(L, R, n, pl, pr); break;
        case 'kick': this.rKick(L, R, n, pl, pr); break;
        case 'snare': this.rSnare(L, R, n, pl, pr); break;
        case 'hat': case 'perc': this.rHat(L, R, n, pl, pr); break;
      }
      return !this.done;
    }

    tick() {
      this.age++;
      if (this.relAt && this.age === this.relAt) this.env.release();
    }

    /* Table read with linear interpolation. Phase is 0…1. */
    static read(t, p) {
      const x = p * TLEN, i = x | 0, fr = x - i;
      return t[i] + (t[i + 1] - t[i]) * fr;
    }

    rWave(L, R, n, pl, pr) {
      const sr = this.eng.sr, inc = this.f / sr;
      for (let i = 0; i < n; i++) {
        this.tick();
        const gl = this.glide > 1.001 || this.glide < 0.999
          ? (this.glide = this.glide + (1 - this.glide) * 0.004, this.glide) : 1;
        const d = inc * gl;
        this.p1 += d; if (this.p1 >= 1) this.p1 -= 1;
        this.p2 += d; if (this.p2 >= 1) this.p2 -= 1;
        if (this.xf < 1) this.xf += this.xfInc;
        let v = Voice.read(this.t0, this.p1) * (1 - this.xf) + Voice.read(this.t1, this.p2) * this.xf;
        this.cutNow += this.cutC * (this.cut * 0.4 - this.cutNow);
        this.filt.set(sr, this.cutNow, 0.7);
        v = this.filt.run(v);
        if (this.sub > 0.02) {
          this.pSub += d * 0.5; if (this.pSub >= 1) this.pSub -= 1;
          v += Math.sin(TAU * this.pSub) * this.sub * 0.55;
        }
        const e = this.env.run();
        if (this.env.done) { this.done = true; return; }
        const o = v * e;
        L[i] += o * pl; R[i] += o * pr;
      }
    }

    rBow(L, R, n, pl, pr) {
      const sr = this.eng.sr, inc = this.f / sr;
      for (let i = 0; i < n; i++) {
        this.tick();
        this.p1 += inc; if (this.p1 >= 1) this.p1 -= 1;
        this.p2 += inc * 1.004; if (this.p2 >= 1) this.p2 -= 1;
        let v = (Voice.read(this.t0, this.p1) + Voice.read(this.t1, this.p2)) * 0.5;
        // Bow pressure: slow filtered noise on the cutoff.
        this.cutNow += 0.0008 * (this.cut * (0.6 + 0.6 * this.rnd()) - this.cutNow);
        this.filt.set(sr, this.cutNow, 1.6);
        v = this.filt.run(v);
        const e = this.env.run();
        if (this.env.done) { this.done = true; return; }
        const o = v * e;
        L[i] += o * pl; R[i] += o * pr;
      }
    }

    rFm(L, R, n, pl, pr) {
      const sr = this.eng.sr, inc = this.f / sr, mInc = (this.f * this.ratio) / sr;
      for (let i = 0; i < n; i++) {
        this.tick();
        this.pMod += mInc; if (this.pMod >= 1) this.pMod -= 1;
        this.index += this.indexC * (this.index * 0.08 - this.index);
        const dev = (Math.sin(TAU * this.pMod) * this.index) / sr;
        this.p1 += inc + dev; this.p1 -= Math.floor(this.p1);
        let v = Voice.read(this.t0, this.p1);
        v = this.filt.run(v);
        if (this.sub > 0.02) {
          this.pSub += inc * 0.5; if (this.pSub >= 1) this.pSub -= 1;
          v += Math.sin(TAU * this.pSub) * this.sub * 0.4;
        }
        const e = this.env.run();
        if (this.env.done) { this.done = true; return; }
        const o = v * e;
        L[i] += o * pl; R[i] += o * pr;
      }
    }

    rBell(L, R, n, pl, pr) {
      const sr = this.eng.sr;
      for (let i = 0; i < n; i++) {
        this.tick();
        let v = 0;
        for (let k = 0; k < 3; k++) {
          this.pp[k] += (this.f * this.parts[k][0]) / sr;
          if (this.pp[k] >= 1) this.pp[k] -= 1;
          this.pv[k] += this.pc[k] * (0 - this.pv[k]);
          v += (k === 0 ? Voice.read(this.t0, this.pp[0]) : Math.sin(TAU * this.pp[k])) * this.parts[k][1] * this.pv[k];
        }
        if (this.pv[0] < 1e-4) { this.done = true; return; }
        const o = v * this.vel * 0.7;
        L[i] += o * pl; R[i] += o * pr;
      }
    }

    rVox(L, R, n, pl, pr) {
      const sr = this.eng.sr, inc = this.f / sr;
      const P = this.P, breath = P.breath ?? 0.2;
      for (let i = 0; i < n; i++) {
        this.tick();
        this.p1 += inc; if (this.p1 >= 1) this.p1 -= 1;
        const src = Voice.read(this.t0, this.p1);        // glottal pulse table
        if (this.morph < 1) {
          this.morph += this.morphInc;
          if ((this.age & 31) === 0) {
            for (let k = 0; k < 4; k++) {
              const f = this.vow[0][k] + (this.vowTo[0][k] - this.vow[0][k]) * Math.min(1, this.morph);
              this.bp[k].set(sr, f, 7 + 7 * (P.bright ?? 0.6));
            }
          }
        }
        let v = 0;
        for (let k = 0; k < 4; k++) { this.bp[k].run(src); v += this.bp[k].bp * this.vow[1][k]; }
        // Consonant articulation, then breath beneath the vowel.
        let nz = this.rnd() * 2 - 1;
        if (this.consLeft > 0) {
          this.consLeft--;
          const lvl = this.consType === 2 ? 0.13 : this.consType === 1 ? 0.18 : 0.05;
          v += nz * lvl * (this.consLeft / (sr * 0.1) + 0.2);
        }
        v += nz * breath * 0.05;
        const e = this.env.run();
        if (this.env.done) { this.done = true; return; }
        const o = v * e * 1.2;
        L[i] += o * pl; R[i] += o * pr;
      }
    }

    rDrone(L, R, n, pl, pr) {
      const sr = this.eng.sr, inc = this.f / sr;
      for (let i = 0; i < n; i++) {
        this.tick();
        this.p1 += inc; if (this.p1 >= 1) this.p1 -= 1;
        this.p2 += inc * 1.4983; if (this.p2 >= 1) this.p2 -= 1;
        this.pSub += inc * 0.5; if (this.pSub >= 1) this.pSub -= 1;
        let v = Voice.read(this.t0, this.p1) * 0.5 + Voice.read(this.t1, this.p2) * 0.3 + Math.sin(TAU * this.pSub) * 0.3;
        this.filt.set(sr, 320 + 140 * Math.sin(this.age * 0.00002), 3);
        v = this.filt.run(v);
        const e = this.env.run();
        if (this.env.done) { this.done = true; return; }
        const o = v * e * 0.5;
        L[i] += o * pl; R[i] += o * pr;
      }
    }

    /* ── Drums ──────────────────────────────────────────────────────── */

    rKick(L, R, n, pl, pr) {
      const sr = this.eng.sr, ev = this.ev;
      for (let i = 0; i < n; i++) {
        this.age++;
        // Pitch envelope: from glide× down into the chord root.
        this.pitchEnv += this.pc2 * (1 - this.pitchEnv);
        const f = this.f * (1 + (ev.glide - 1) * (1 - this.pitchEnv));
        this.p1 += f / sr; if (this.p1 >= 1) this.p1 -= 1;
        this.pSub += this.f / sr; if (this.pSub >= 1) this.pSub -= 1;
        this.p2 += (this.f * 2.01) / sr; if (this.p2 >= 1) this.p2 -= 1;

        this.lvl += this.dC * (0 - this.lvl);
        this.nLvl += this.nC * (0 - this.nLvl);
        if (this.lvl < 1e-4) { this.done = true; return; }

        const body = Math.sin(TAU * this.p1) * this.lvl * 0.85;
        const sub = Math.sin(TAU * this.pSub) * this.lvl * 0.9 * (ev.sub || 0.8);
        const harm = Math.sin(TAU * this.p2) * this.lvl * (0.22 * (ev.sub || 0.8) + 0.08);
        const click = (this.rnd() * 2 - 1) * this.nLvl * 0.45 * (ev.click || 0.5);
        let v = body + sub + harm + click;
        v = Math.tanh(v * (1 + 1.2 * (ev.punch || 0.6)));   // saturation gives weight
        const o = v * this.vel;
        L[i] += o * pl; R[i] += o * pr;
      }
    }

    rSnare(L, R, n, pl, pr) {
      const sr = this.eng.sr, ev = this.ev;
      for (let i = 0; i < n; i++) {
        this.age++;
        this.pitchEnv += this.pc2 * (1 - this.pitchEnv);
        const f = this.f * (1 + 0.4 * (1 - this.pitchEnv));
        this.p1 += f / sr; if (this.p1 >= 1) this.p1 -= 1;
        this.p2 += (f * 2) / sr; if (this.p2 >= 1) this.p2 -= 1;
        this.lvl += this.dC * (0 - this.lvl);
        this.nLvl += this.nC * (0 - this.nLvl);
        if (this.lvl < 1e-4 && this.nLvl < 1e-4) { this.done = true; return; }

        const body = (Math.sin(TAU * this.p1) * 0.5 + Math.sin(TAU * this.p2) * 0.12) * this.lvl * (ev.body || 1);
        const nz = this.rnd() * 2 - 1;
        this.filt.run(nz);
        this.filt2.run(nz);
        const noise = (this.filt.bp * 0.55 * (ev.noise || 1) + this.filt2.hp * 0.28 * (ev.snap || 1)) * this.nLvl;
        const o = (body + noise) * this.vel;
        L[i] += o * pl; R[i] += o * pr;
      }
    }

    rHat(L, R, n, pl, pr) {
      const ev = this.ev;
      for (let i = 0; i < n; i++) {
        this.age++;
        this.nLvl += this.dC * (0 - this.nLvl);
        if (this.nLvl < 1e-4) { this.done = true; return; }
        const nz = this.rnd() * 2 - 1;
        this.filt.run(nz);
        this.filt2.run(this.filt.hp);
        const o = (this.filt.hp * 0.6 + this.filt2.bp * 0.5) * this.nLvl * this.vel * (ev.lvl || 1);
        L[i] += o * pl; R[i] += o * pr;
      }
    }
  }

  /* ── Effects ─────────────────────────────────────────────────────────── */

  class Chorus {
    constructor(sr) {
      this.sr = sr;
      this.n = Math.ceil(sr * 0.06);
      this.bL = new Float32Array(this.n); this.bR = new Float32Array(this.n);
      this.w = 0; this.ph1 = 0; this.ph2 = 0.37;
    }
    run(L, R, n, wet) {
      if (wet <= 0.001) return;
      const sr = this.sr;
      for (let i = 0; i < n; i++) {
        this.ph1 += 0.23 / sr; if (this.ph1 >= 1) this.ph1 -= 1;
        this.ph2 += 0.31 / sr; if (this.ph2 >= 1) this.ph2 -= 1;
        const d1 = (0.012 + 0.0035 * Math.sin(TAU * this.ph1)) * sr;
        const d2 = (0.019 + 0.0028 * Math.sin(TAU * this.ph2)) * sr;
        const rd = (buf, d) => {
          let p = this.w - d;
          while (p < 0) p += this.n;
          const i0 = p | 0, fr = p - i0, i1 = (i0 + 1) % this.n;
          return buf[i0] + (buf[i1] - buf[i0]) * fr;
        };
        const l = rd(this.bL, d1), r = rd(this.bR, d2);
        this.bL[this.w] = L[i]; this.bR[this.w] = R[i];
        this.w = (this.w + 1) % this.n;
        L[i] += l * wet; R[i] += r * wet;
      }
    }
  }

  /** A four-line feedback delay network: a real room, far cheaper than convolution. */
  class Reverb {
    constructor(sr) {
      this.sr = sr;
      this.len = [0.0297, 0.0371, 0.0411, 0.0437].map((s) => Math.round(s * sr));
      this.buf = this.len.map((l) => new Float32Array(l));
      this.idx = [0, 0, 0, 0];
      this.damp = [new OnePole(0.4), new OnePole(0.4), new OnePole(0.4), new OnePole(0.4)];
      this.fb = 0.82;
    }
    set(size, damping) {
      this.fb = clamp(0.6 + 0.36 * size, 0, 0.96);
      for (const d of this.damp) d.c = clamp(0.12 + 0.6 * (1 - damping), 0.03, 0.9);
    }
    run(inL, inR, L, R, n, wet) {
      if (wet <= 0.001) return;
      for (let i = 0; i < n; i++) {
        const x = (inL[i] + inR[i]) * 0.5;
        const a = this.buf[0][this.idx[0]], b = this.buf[1][this.idx[1]];
        const c = this.buf[2][this.idx[2]], d = this.buf[3][this.idx[3]];
        // Hadamard mix keeps the lines from correlating into a ringing tone.
        const o0 = (a + b + c + d) * 0.5, o1 = (a - b + c - d) * 0.5;
        const o2 = (a + b - c - d) * 0.5, o3 = (a - b - c + d) * 0.5;
        this.buf[0][this.idx[0]] = this.damp[0].run(x + o0 * this.fb);
        this.buf[1][this.idx[1]] = this.damp[1].run(x + o1 * this.fb);
        this.buf[2][this.idx[2]] = this.damp[2].run(x + o2 * this.fb);
        this.buf[3][this.idx[3]] = this.damp[3].run(x + o3 * this.fb);
        for (let k = 0; k < 4; k++) this.idx[k] = (this.idx[k] + 1) % this.len[k];
        L[i] += (a + c) * 0.5 * wet;
        R[i] += (b + d) * 0.5 * wet;
      }
    }
  }

  class Delay {
    constructor(sr) { this.sr = sr; this.n = Math.ceil(sr * 2); this.bL = new Float32Array(this.n); this.bR = new Float32Array(this.n); this.w = 0; this.time = 0.4; this.fb = 0.36; this.lp = [new OnePole(0.35), new OnePole(0.35)]; }
    run(inL, inR, L, R, n, wet) {
      if (wet <= 0.001) return;
      const d = Math.max(1, Math.round(this.time * this.sr));
      for (let i = 0; i < n; i++) {
        let p = this.w - d; if (p < 0) p += this.n;
        const l = this.bL[p], r = this.bR[p];
        this.bL[this.w] = inL[i] + this.lp[0].run(l) * this.fb;
        this.bR[this.w] = inR[i] + this.lp[1].run(r) * this.fb;
        this.w = (this.w + 1) % this.n;
        L[i] += l * wet; R[i] += r * wet;
      }
    }
  }

  /** Bit depth, sample hold, fold and drive. The same maths as the old worklet. */
  function crush(L, R, n, p) {
    if (p.mix <= 0.001) return;
    const levels = Math.pow(2, p.bits - 1);
    const k = 1 + p.drive * 5, norm = p.drive > 0 ? Math.tanh(k) : 1;
    const hold = Math.max(1, Math.round(p.hold));
    for (let i = 0; i < n; i++) {
      if (p.count % hold === 0) {
        for (let c = 0; c < 2; c++) {
          const x = c ? R[i] : L[i];
          let v = p.drive > 0 ? Math.tanh(x * k) / norm : x;
          if (p.fold > 0) v = (1 - p.fold) * v + p.fold * Math.sin(v * Math.PI * 0.5 * (1 + 3 * p.fold));
          v = clamp(v, -1, 1);
          p.held[c] = Math.round(v * levels) / levels;
        }
      }
      p.count++;
      L[i] = L[i] * (1 - p.mix) + p.held[0] * p.mix;
      R[i] = R[i] * (1 - p.mix) + p.held[1] * p.mix;
    }
  }

  /* ── Engine ──────────────────────────────────────────────────────────── */

  const BUSES = ['lead', 'harm', 'bell', 'pad', 'bass', 'arp', 'drums', 'drone'];
  const MAX_VOICES = 64;

  class EngineCore {
    constructor(sr, maxBlock) {
      this.sr = sr;
      this.block = maxBlock || 128;
      this.pos = 0;                  // samples since the plan started
      this.playing = false;
      this.plan = null;
      this.tables = new Map();
      this.ptr = 0; this.loopIndex = 0;
      this.voices = [];
      for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice());
      this.bus = {};
      for (const b of BUSES) this.bus[b] = { L: new Float32Array(this.block), R: new Float32Array(this.block), gain: 1, peak: 0 };
      this.mixL = new Float32Array(this.block); this.mixR = new Float32Array(this.block);
      this.drumL = new Float32Array(this.block); this.drumR = new Float32Array(this.block);
      this.sendL = new Float32Array(this.block); this.sendR = new Float32Array(this.block);
      this.chorus = new Chorus(sr);
      this.reverb = new Reverb(sr);
      this.delay = new Delay(sr);
      this.crushP = { bits: 16, hold: 1, fold: 0, drive: 0, mix: 0, count: 0, held: [0, 0] };
      this.duck = 1; this.duckEnv = 0;
      this.levels = {};
      this.master = 0.85;
      this.meters = {};
    }

    setPlan(plan) {
      this.plan = plan;
      this.tables.clear();
      for (const k in plan.tables) this.tables.set(k, plan.tables[k]);
      this.ptr = 0; this.loopIndex = 0;
      this.reverb.set(plan.room ?? 0.6, plan.damp ?? 0.5);
      this.delay.time = (plan.spb || 0.6) * 0.75;
    }
    setPatchAt(sections) { if (this.plan) this.plan.sections = sections; }
    setLevels(l) { this.levels = l || {}; }
    seek(beat) {
      this.pos = Math.round(beat * (this.plan.spb || 0.6) * this.sr);
      this.ptr = 0; this.loopIndex = 0;
      const t = this.pos / this.sr;
      const ev = this.plan.events;
      while (this.ptr < ev.length && ev[this.ptr].t < t) this.ptr++;
      for (const v of this.voices) v.done = true;
    }

    table(key, f) {
      const tiers = this.tables.get(key) || this.tables.get('fallback');
      if (!tiers) return null;
      const lim = this.sr * 0.45;
      for (let i = 0; i < TIERS.length; i++) if (TIERS[i] * f < lim) return tiers[i];
      return tiers[TIERS.length - 1];
    }

    sectionFor(t) {
      const s = this.plan.sections, spb = this.plan.spb;
      let p = s[0].P;
      for (const sec of s) { if (t >= sec.start * spb) p = sec.P; else break; }
      return p;
    }

    spawn(ev) {
      let v = null;
      for (const c of this.voices) if (c.done) { v = c; break; }
      if (!v) {                                   // steal the oldest
        let best = this.voices[0];
        for (const c of this.voices) if (c.age > best.age) best = c;
        v = best;
      }
      const P = this.sectionFor(ev.t);
      v.init(this, ev, P);
    }

    /** Render one block into out[0]/out[1]. */
    process(outL, outR, n) {
      const plan = this.plan;
      if (!plan || !this.playing) { outL.fill(0); outR.fill(0); return; }
      const sr = this.sr, spb = plan.spb, totalSec = plan.total * spb;

      for (const b of BUSES) { this.bus[b].L.fill(0, 0, n); this.bus[b].R.fill(0, 0, n); }

      // Dispatch every event that starts inside this block.
      const t0 = this.pos / sr, t1 = t0 + n / sr;
      const ev = plan.events;
      for (let guard = 0; guard < 512; guard++) {
        if (this.ptr >= ev.length) {
          if (!plan.loop) break;
          this.loopIndex++; this.ptr = 0;
          this.pos -= Math.round(totalSec * sr);
          break;
        }
        const e = ev[this.ptr];
        if (e.t >= t1 - (this.pos / sr - t0)) break;
        if (e.t >= t0) { this.spawn(e); this.ptr++; } else this.ptr++;
      }

      for (const v of this.voices) {
        if (v.done) continue;
        const b = this.bus[v.bus] || this.bus.lead;
        v.run(b.L, b.R, n);
      }

      // Bus gains, the music sum, and the drum sum kept apart for sidechain.
      this.mixL.fill(0, 0, n); this.mixR.fill(0, 0, n);
      this.drumL.fill(0, 0, n); this.drumR.fill(0, 0, n);
      this.sendL.fill(0, 0, n); this.sendR.fill(0, 0, n);
      const P = this.sectionFor(this.pos / sr);

      for (const name of BUSES) {
        const b = this.bus[name];
        const g = (this.levels[name] ?? 1) * (b.gain ?? 1);
        const toDrums = name === 'drums';
        const rev = name === 'bass' ? 0.04 : name === 'drums' ? 0.1 : 0.4;
        let peak = 0;
        for (let i = 0; i < n; i++) {
          const l = b.L[i] * g, r = b.R[i] * g;
          if (toDrums) { this.drumL[i] += l; this.drumR[i] += r; }
          else { this.mixL[i] += l; this.mixR[i] += r; }
          this.sendL[i] += l * rev; this.sendR[i] += r * rev;
          const m = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
          if (m > peak) peak = m;
        }
        this.meters[name] = peak;
      }

      // Chorus on the music, then reverb and delay returns.
      this.chorus.run(this.mixL, this.mixR, n, (P.chorus ?? 0) * 0.85);
      this.reverb.run(this.sendL, this.sendR, this.mixL, this.mixR, n, 0.5);
      this.delay.run(this.mixL, this.mixR, this.mixL, this.mixR, n, 0.2 + (P.echo ?? 0.3) * 0.5);

      // Sidechain: a real envelope follower on the drums, not a scheduled dip.
      const atk = 1 - Math.exp(-1 / (0.002 * sr)), rel = 1 - Math.exp(-1 / (0.12 * sr));
      const depth = clamp(this.duckDepth ?? 0.5, 0, 1);
      for (let i = 0; i < n; i++) {
        const d = Math.abs(this.drumL[i]) > Math.abs(this.drumR[i]) ? Math.abs(this.drumL[i]) : Math.abs(this.drumR[i]);
        this.duckEnv += (d > this.duckEnv ? atk : rel) * (d - this.duckEnv);
        const g = 1 - clamp(this.duckEnv * 2.2, 0, 1) * depth;
        this.mixL[i] *= g; this.mixR[i] *= g;
      }

      // Crusher on the music only, so the kit stays clean.
      this.crushP.bits = P.grit > 0 ? P.bits : 16;
      this.crushP.hold = P.hold ?? 1;
      this.crushP.fold = P.fold ?? 0;
      this.crushP.drive = P.drive ?? 0;
      this.crushP.mix = P.grit ?? 0;
      crush(this.mixL, this.mixR, n, this.crushP);

      // Drum glue, parallel compression, then the master limiter.
      for (let i = 0; i < n; i++) {
        const dl = this.drumL[i], dr = this.drumR[i];
        const par = 0.35;
        const cl = Math.tanh(dl * 3) * par, cr = Math.tanh(dr * 3) * par;
        let l = (this.mixL[i] + dl + cl) * this.master;
        let r = (this.mixR[i] + dr + cr) * this.master;
        outL[i] = Math.tanh(l * 1.05) * 0.92;
        outR[i] = Math.tanh(r * 1.05) * 0.92;
      }

      this.pos += n;
    }
  }

  return { EngineCore, buildTables, TIERS, TLEN, Voice, SVF, Env, rng };
})();

if (typeof globalThis !== 'undefined') globalThis.SigilDSP = SigilDSP;