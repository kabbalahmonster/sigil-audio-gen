'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   SIGIL KERNEL — the DSP layer
   --------------------------------------------------------------------------
   Plain JavaScript. No Web Audio, no DOM, no imports. ONE function holds the
   whole kernel, so the same source runs in three places:
     page     builds wavetables and plans          (classic <script>)
     worklet  plays, on the audio thread           (spawned from this source)
     worker   renders offline, faster than real time (spawned from this source)
   Identical code in all three means a render equals a performance.

   THE SPLIT
     The host thinks musically and sends a PLAN: a flat Float64Array of events
     measured in BEATS (layout: EV). The kernel only makes sound. It owns the
     transport, so tempo, seek and looping are exact and never depend on the
     main thread.

   RULES FOR THE AUDIO PATH
     • no allocation inside process(): voices are pooled, buffers are reused
     • filter coefficients move at control rate (every CTL samples)
     • every noise source is a per-voice integer PRNG seeded from the event's
       musical identity, so output is deterministic
     • a NaN anywhere trips panic(): effects are cleared and playback carries on

   TO ADD AN INSTRUMENT: write a class in §K4 (init + render), then one
   define() line in §K5. Nothing else in the kernel changes.
   ══════════════════════════════════════════════════════════════════════════ */
function SigilKernelFactory(scope) {
  'use strict';

  /* ── §K0 CONSTANTS AND LAYOUT ─────────────────────────────────────────── */
  const TAU = Math.PI * 2;
  const TINY = 1e-18;          // keeps feedback paths out of the denormal range
  const BLOCK = 128;           // render quantum
  const CTL = 16;              // control-rate interval, in samples (power of two)
  const SPARE = 4;             // voices kept beyond each instrument's polyphony, for click-free stealing
  const REPORT = 2048;         // frames between state reports to the host (~21 Hz)
  const TLEN = 2048, TROW = TLEN + 1;
  const TIERS = [32, 20, 12, 8, 5, 2];   // band-limited versions of every wavetable, by top partial
  const NT = TIERS.length;
  const LCG_A = 1664525, LCG_C = 1013904223, I2F = 4.656612873077393e-10;   // int32 → [-1, 1)
  const SAT_NORM = 1 / Math.tanh(1.8);

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const num = (v, d) => (typeof v === 'number' && v - v === 0 ? v : d);       // finite number, or the default
  const inc01 = (f, sr) => { const v = f / sr; return v < 0.49 ? v : 0.49; }; // a phase increment that can never skip a cycle
  const fall = (tau, sr) => Math.exp(-1 / (Math.max(0.0005, tau) * sr));      // per-sample multiplier of an exponential decay
  const lag = (tau, sr) => 1 - fall(tau, sr);                                 // one-pole coefficient for the same time constant

  /** Event layout. One event = STRIDE float64s. P…P+10 are the instrument's own parameters. */
  const EV = { BEAT: 0, KIND: 1, BUS: 2, FREQ: 3, FROM: 4, DUR: 5, VEL: 6, PAN: 7, TA: 8, TB: 9, FLAGS: 10,
               DUCK: 11, DUCKLEN: 12, P: 13, STRIDE: 24 };
  const NP = EV.STRIDE - EV.P;

  /** Scene layout: per-section effect settings, applied when the playhead enters the section. */
  const SC = { BEAT: 0, CHORUS: 1, ECHO: 2, MIX: 3, BITS: 4, HOLD: 5, FOLD: 6, DRIVE: 7, STRIDE: 8 };

  /** Buses: name, level, reverb send, echo send, chorus send, destination (0 music · 1 drums · 2 post), saturate. */
  const BUS_DEF = [
    ['lead',   0.9,  0.32, 0.22, 1, 0, 0],
    ['harm',   0.55, 0.45, 0.10, 0, 0, 0],
    ['bell',   0.8,  0.55, 0.28, 0, 0, 0],
    ['pad',    0.8,  0.50, 0,    1, 0, 0],
    ['bass',   0.85, 0.04, 0,    0, 0, 1],
    ['arp',    0.55, 0.35, 0.42, 0, 0, 0],
    ['drums',  0.85, 0.12, 0,    0, 1, 0],
    ['drone',  0.7,  0.45, 0,    0, 0, 0],
    ['play',   0.9,  0.35, 0.15, 1, 0, 0],   // notes played by hand
    ['ritual', 0.8,  0.55, 0.28, 0, 2, 0],   // ticks, chimes, fire: bypass duck, crusher and the tone filter
  ];
  const NB = BUS_DEF.length;
  const BUS = {};
  BUS_DEF.forEach((b, i) => (BUS[b[0]] = i));

  /** Smoothed parameters: name, default, default smoothing time (s; 0 = immediate). */
  const PARAM_DEF = [
    ['master', 0.85, 0.03], ['tone', 20000, 0.04], ['space', 0.85, 0.08],
    ['echo', 0.55, 0.06], ['echoFb', 0.36, 0.06], ['chorus', 0, 0.06],
    ['crushMix', 0, 0.03], ['crushBits', 16, 0], ['crushHold', 1, 0], ['crushFold', 0, 0.03], ['crushDrive', 0, 0.03],
    ['duck', 1, 0.05],
  ].concat(BUS_DEF.map((b) => ['bus.' + b[0], b[1], 0.05]));
  const NPAR = PARAM_DEF.length;
  const PIX = {};
  PARAM_DEF.forEach((p, i) => (PIX[p[0]] = i));
  const P_MASTER = PIX.master, P_TONE = PIX.tone, P_SPACE = PIX.space, P_ECHO = PIX.echo, P_ECHOFB = PIX.echoFb,
        P_CHORUS = PIX.chorus, P_CMIX = PIX.crushMix, P_CBITS = PIX.crushBits, P_CHOLD = PIX.crushHold,
        P_CFOLD = PIX.crushFold, P_CDRIVE = PIX.crushDrive, P_DUCK = PIX.duck, P_BUS = PIX['bus.' + BUS_DEF[0][0]];

  /** Mix constants that were chosen by calculation, not by ear. Trim these first if the balance is off. */
  const MIX = { masterMakeup: 1.6, drumMakeup: 1.5, early: 0.5, chorus: 0.85, echoToReverb: 0.25 };

  /* ── §K1 SHARED TABLES ────────────────────────────────────────────────── */
  const SIN_N = 4096, SIN_MASK = SIN_N - 1;
  const SINT = new Float32Array(SIN_N + 1);
  for (let i = 0; i <= SIN_N; i++) SINT[i] = Math.sin((TAU * i) / SIN_N);

  /** Formant frequencies (4) then gains (4): ah eh ee oh oo. */
  const VOWELS = [
    [800, 1150, 2900, 3900, 1, 0.50, 0.25, 0.12],
    [530, 1840, 2480, 3500, 1, 0.45, 0.22, 0.10],
    [270, 2290, 3010, 3500, 1, 0.40, 0.30, 0.12],
    [450, 800, 2830, 3800, 1, 0.60, 0.20, 0.10],
    [325, 700, 2530, 3500, 1, 0.50, 0.18, 0.08],
  ];
  const HAT_SETS = [null, [1, 1.4471, 1.6317, 1.9323, 2.5465, 2.7], [1, 1.3, 1.63, 1.95, 2.47, 3.0], [1, 1.4, 1.67, 2.1, 2.74, 3.3]];

  /**
   * Band-limited wavetables from a spectrum (re = cosine terms, im = sine terms, index = partial).
   * Returns ONE Float32Array holding NT rows of TROW samples: row k keeps partials 1…TIERS[k].
   * Runs on the host, never on the audio thread.
   */
  function buildTables(re, im) {
    const out = new Float32Array(NT * TROW);
    const acc = new Float64Array(TLEN);
    const top = Math.min(TIERS[0], re.length - 1);
    const k = SIN_N / TLEN;
    let tier = NT - 1;
    for (let h = 1; h <= TIERS[0]; h++) {
      if (h <= top) {
        const s = im[h], c = re[h];
        if (s || c) {
          for (let i = 0; i < TLEN; i++) {
            const a = (h * i * k) & SIN_MASK;
            acc[i] += s * SINT[a] + c * SINT[(a + (SIN_N >> 2)) & SIN_MASK];
          }
        }
      }
      while (tier >= 0 && TIERS[tier] === h) {
        let mx = 1e-9;
        for (let i = 0; i < TLEN; i++) { const a = Math.abs(acc[i]); if (a > mx) mx = a; }
        const row = tier * TROW;
        for (let i = 0; i < TLEN; i++) out[row + i] = acc[i] / mx;
        out[row + TLEN] = out[row];
        tier--;
      }
    }
    return out;
  }

  /* ── §K2 BUILDING BLOCKS ──────────────────────────────────────────────── */

  /** Topology-preserving state variable filter: stable under modulation; low, band and high pass from one state. */
  class SVF {
    constructor() { this.a1 = 1; this.a2 = 0; this.a3 = 0; this.k = 1; this.z1 = 0; this.z2 = 0; }
    reset() { this.z1 = 0; this.z2 = 0; }
    set(fc, q, sr) {
      const lim = sr * 0.45;
      fc = fc > lim ? lim : fc > 16 ? fc : 16;          // also catches NaN
      const g = Math.tan((Math.PI * fc) / sr);
      this.k = 1 / (q > 0.3 ? q : 0.3);
      this.a1 = 1 / (1 + g * (g + this.k));
      this.a2 = g * this.a1;
      this.a3 = g * this.a2;
    }
    lp(x) {
      const v3 = x - this.z2, v1 = this.a1 * this.z1 + this.a2 * v3, v2 = this.z2 + this.a2 * this.z1 + this.a3 * v3;
      this.z1 = 2 * v1 - this.z1; this.z2 = 2 * v2 - this.z2;
      return v2;
    }
    /** Band pass with unity gain at the centre, like a Web Audio bandpass. */
    bp(x) {
      const v3 = x - this.z2, v1 = this.a1 * this.z1 + this.a2 * v3, v2 = this.z2 + this.a2 * this.z1 + this.a3 * v3;
      this.z1 = 2 * v1 - this.z1; this.z2 = 2 * v2 - this.z2;
      return v1 * this.k;
    }
    hp(x) {
      const v3 = x - this.z2, v1 = this.a1 * this.z1 + this.a2 * v3, v2 = this.z2 + this.a2 * this.z1 + this.a3 * v3;
      this.z1 = 2 * v1 - this.z1; this.z2 = 2 * v2 - this.z2;
      return x - this.k * v1 - v2;
    }
  }

  /** Linear attack, exponential decay to sustain, exponential release. d and r are TIME CONSTANTS. stage 0 = finished. */
  class Env {
    constructor() { this.v = 0; this.stage = 0; this.aInc = 0; this.dC = 0; this.sus = 0; this.rC = 0; this.peak = 0; this.floor = 1e-6; }
    start(sr, a, d, s, r, peak) {
      this.peak = peak; this.sus = s * peak;
      this.aInc = peak / Math.max(1, a * sr);
      this.dC = lag(d, sr); this.rC = lag(r, sr);
      this.floor = Math.max(peak * 0.001, 1e-6);
      this.v = 0; this.stage = peak > 0 ? 1 : 0;
    }
    release() { if (this.stage !== 0) this.stage = 3; }
    next() {
      if (this.stage === 1) { this.v += this.aInc; if (this.v >= this.peak) { this.v = this.peak; this.stage = 2; } }
      else if (this.stage === 2) { this.v += this.dC * (this.sus - this.v); if (this.v < this.floor) { this.v = 0; this.stage = 0; } }
      else if (this.stage === 3) { this.v -= this.rC * this.v; if (this.v < this.floor) { this.v = 0; this.stage = 0; } }
      return this.v;
    }
  }

  /* ── §K3 THE VOICE STRIP ───────────────────────────────────────────────
     Every instrument extends Voice. An instrument writes MONO samples into a
     scratch buffer; the kernel applies pan, stop/steal fades and routes the
     result to a bus. The kernel also calls release() on the exact sample the
     note ends, so instruments never count note length themselves.

       init(K, e, o, spb)       read the event at e[o…] and reset all state
       render(out, from, to)    write out[from…to); return the index after the
                                last sample written; set this.on = false when done
       release()                begin the release phase
     ─────────────────────────────────────────────────────────────────────── */
  class Voice {
    constructor(sr) {
      this.sr = sr; this.on = false; this.kind = 0; this.bus = 0;
      this.gl = 1; this.gr = 1;                 // pan gains
      this.fade = 1; this.fadeInc = 0;          // stop / steal fade
      this.offset = 0;                          // first sample inside the current block
      this.hold = Infinity;                     // samples until release() is called for us
      this.born = 0; this.group = 0; this.id = 0; this.seed = 1;
    }
    release() {}
  }

  /* ── §K4 INSTRUMENTS ──────────────────────────────────────────────────── */

  /** Wavetable: two cube cells crossfaded across the note, a falling low-pass, optional sub and vibrato. */
  class WaveVoice extends Voice {
    constructor(sr) {
      super(sr);
      this.env = new Env(); this.svf = new SVF();
      this.tA = null; this.tB = null;
      this.p = 0; this.pS = 0; this.pV = 0;
      this.inc = 0; this.incNow = 0; this.gl8 = 1; this.glC = 0;
      this.xf = 0; this.xfInc = 0;
      this.cut = 0; this.cutTo = 0; this.cutC = 0; this.q = 0.7;
      this.sub = 0; this.vib = 0; this.vibNow = 0; this.vibInc = 0; this.vInc = 0;
      this.c = 0;
    }
    init(K, e, o, spb) {
      const sr = this.sr, X = WaveVoice.X, P = o + EV.P;
      const f = e[o + EV.FREQ], from = e[o + EV.FROM], d = K.secs(e[o + EV.DUR], spb);
      this.tA = K.table(e[o + EV.TA], f);
      this.tB = K.table(e[o + EV.TB], f);
      this.inc = inc01(f, sr);
      this.gl8 = from > 0 ? from / f : 1;
      this.glC = 1 - Math.exp(-CTL / (0.03 * sr));
      this.xf = 0;
      this.xfInc = this.tA !== this.tB ? 1 / (d * sr) : 0;
      this.cut = e[P + X.cut];
      this.cutTo = this.cut * e[P + X.cutEnd];
      this.cutC = 1 - Math.exp(-CTL / (Math.max(0.01, e[P + X.cutTau]) * sr));
      this.q = e[P + X.q];
      this.sub = e[P + X.sub];
      this.vib = e[P + X.vib]; this.vibNow = 0;
      this.vibInc = this.vib > 0 ? (this.vib * CTL) / (Math.min(0.6, d * 0.6) * sr) : 0;
      this.vInc = (5.4 * CTL) / sr;
      this.p = (this.seed >>> 8) / 16777216;    // a seeded start phase, so unison voices do not stack their first cycle
      this.pS = 0; this.pV = 0; this.c = 0;
      this.svf.reset();
      this.env.start(sr, e[P + X.a], e[P + X.d], e[P + X.s], e[P + X.r], e[P + X.peak] * e[o + EV.VEL]);
    }
    release() { this.env.release(); }
    ctl() {
      if (this.gl8 !== 1) { this.gl8 += this.glC * (1 - this.gl8); if (Math.abs(this.gl8 - 1) < 1e-4) this.gl8 = 1; }
      let inc = this.inc * this.gl8;
      if (this.vib > 0) {
        if (this.vibNow < this.vib) this.vibNow += this.vibInc;
        this.pV += this.vInc; if (this.pV >= 1) this.pV -= 1;
        inc *= 1 + this.vibNow * SINT[(this.pV * SIN_N) | 0];
      }
      this.incNow = inc < 0.49 ? inc : 0.49;
      this.cut += this.cutC * (this.cutTo - this.cut);
      this.svf.set(this.cut, this.q, this.sr);
    }
    render(out, from, to) {
      const tA = this.tA, tB = this.tB, svf = this.svf, env = this.env, sub = this.sub, xfInc = this.xfInc;
      let p = this.p, pS = this.pS, xf = this.xf, inc = this.incNow, c = this.c, i = from;
      for (; i < to; i++) {
        if ((c++ & 15) === 0) { this.ctl(); inc = this.incNow; }
        p += inc; if (p >= 1) p -= 1;
        const x = p * TLEN, j = x | 0, fr = x - j;
        let s = tA[j] + (tA[j + 1] - tA[j]) * fr;
        if (xfInc !== 0) {
          s += (tB[j] + (tB[j + 1] - tB[j]) * fr - s) * xf;
          if (xf < 1) xf += xfInc;
        }
        s = svf.lp(s);
        if (sub > 0) { pS += inc * 0.5; if (pS >= 1) pS -= 1; s += SINT[(pS * SIN_N) | 0] * sub; }
        out[i] = s * env.next();
        if (env.stage === 0) { this.on = false; i++; break; }
      }
      this.p = p; this.pS = pS; this.xf = xf; this.c = c;
      return i;
    }
  }

  /** Vox: a glottal pulse through four morphing formants, with a consonant at the onset and breath beneath. */
  class VoxVoice extends Voice {
    constructor(sr) {
      super(sr);
      this.env = new Env();
      this.f0 = new SVF(); this.f1 = new SVF(); this.f2 = new SVF(); this.f3 = new SVF();
      this.cf = new SVF(); this.bf = new SVF();
      this.fa = new Float64Array(4); this.fb = new Float64Array(4);
      this.g0 = 0; this.g1 = 0; this.g2 = 0; this.g3 = 0;
      this.t = null; this.p = 0; this.pS = 0; this.pV = 0;
      this.inc = 0; this.incNow = 0; this.gl8 = 1; this.glC = 0;
      this.q = 9; this.m = 0; this.mInc = 0;
      this.plosive = false; this.cEnv = 0; this.cC = 0; this.th = 0; this.thC = 0;
      this.breath = 0; this.bNow = 0; this.bInc = 0;
      this.sub = 0; this.vib = 0; this.vibNow = 0; this.vibInc = 0; this.vInc = 0;
      this.c = 0;
    }
    init(K, e, o, spb) {
      const sr = this.sr, X = VoxVoice.X, P = o + EV.P;
      const f = e[o + EV.FREQ], from = e[o + EV.FROM], vel = e[o + EV.VEL], d = K.secs(e[o + EV.DUR], spb);
      const va = VOWELS[clamp(e[P + X.v0] | 0, 0, 4)], vb = VOWELS[clamp(e[P + X.v1] | 0, 0, 4)];
      const tk = e[P + X.throat] > 0 ? e[P + X.throat] : 1;
      const cons = e[P + X.cons] | 0;             // 0 liquid · 1 plosive · 2 fricative · 3 nasal
      const nasal = cons === 3;
      for (let i = 0; i < 4; i++) { this.fa[i] = va[i] * tk * (nasal ? 0.75 : 1); this.fb[i] = vb[i] * tk; }
      this.g0 = va[4]; this.g1 = va[5]; this.g2 = va[6] * (nasal ? 0.5 : 1); this.g3 = va[7] * (nasal ? 0.5 : 1);
      this.q = e[P + X.q];
      this.m = 0; this.mInc = CTL / (Math.min(d * 0.9, 0.7) * sr);
      this.t = K.table(e[o + EV.TA], f);
      this.inc = inc01(f, sr);
      this.gl8 = cons === 0 ? 0.82 : from > 0 ? from / f : 1;   // a liquid glides up into pitch
      this.glC = 1 - Math.exp(-CTL / (0.03 * sr));
      this.plosive = cons === 1;
      this.cEnv = e[P + X.consLvl] * vel;
      this.cC = lag(cons === 2 ? 0.09 : 0.022, sr);
      this.cf.set(e[P + X.consF], cons === 1 ? 1.4 : 0.7, sr);
      this.th = cons === 1 ? vel * 0.12 : 0;      // a plosive thumps the tract
      this.thC = lag(0.018, sr);
      this.breath = e[P + X.breath] * vel; this.bNow = 0; this.bInc = (this.breath * CTL) / (0.04 * sr);
      this.bf.set(3200 * tk, 0.9, sr);
      this.sub = e[P + X.sub];
      this.vib = e[P + X.vib]; this.vibNow = 0;
      this.vibInc = this.vib > 0 ? (this.vib * CTL) / (Math.min(0.6, d * 0.6) * sr) : 0;
      this.vInc = (5.4 * CTL) / sr;
      this.p = 0; this.pS = 0; this.pV = 0; this.c = 0;
      this.f0.reset(); this.f1.reset(); this.f2.reset(); this.f3.reset(); this.cf.reset(); this.bf.reset();
      this.env.start(sr, 0.012, 0.083, 0.78, 0.073, e[P + X.peak] * vel);
    }
    release() { this.env.release(); }
    ctl() {
      const sr = this.sr;
      if (this.gl8 !== 1) { this.gl8 += this.glC * (1 - this.gl8); if (Math.abs(this.gl8 - 1) < 1e-4) this.gl8 = 1; }
      let inc = this.inc * this.gl8;
      if (this.vib > 0) {
        if (this.vibNow < this.vib) this.vibNow += this.vibInc;
        this.pV += this.vInc; if (this.pV >= 1) this.pV -= 1;
        inc *= 1 + this.vibNow * SINT[(this.pV * SIN_N) | 0];
      }
      this.incNow = inc < 0.49 ? inc : 0.49;
      if (this.m < 1) {
        this.m += this.mInc;
        const m = this.m > 1 ? 1 : this.m, q = this.q, a = this.fa, b = this.fb;
        this.f0.set(a[0] + (b[0] - a[0]) * m, q, sr);
        this.f1.set(a[1] + (b[1] - a[1]) * m, q, sr);
        this.f2.set(a[2] + (b[2] - a[2]) * m, q, sr);
        this.f3.set(a[3] + (b[3] - a[3]) * m, q, sr);
      }
      if (this.bNow < this.breath) this.bNow += this.bInc;
    }
    render(out, from, to) {
      const t = this.t, env = this.env, f0 = this.f0, f1 = this.f1, f2 = this.f2, f3 = this.f3, cf = this.cf, bf = this.bf;
      const g0 = this.g0, g1 = this.g1, g2 = this.g2, g3 = this.g3, cC = this.cC, thC = this.thC, sub = this.sub, plosive = this.plosive;
      let p = this.p, pS = this.pS, inc = this.incNow, c = this.c, seed = this.seed, cEnv = this.cEnv, th = this.th, i = from;
      for (; i < to; i++) {
        if ((c++ & 15) === 0) { this.ctl(); inc = this.incNow; }
        p += inc; if (p >= 1) p -= 1;
        const x = p * TLEN, j = x | 0;
        const src = t[j] + (t[j + 1] - t[j]) * (x - j);
        let s = f0.bp(src) * g0 + f1.bp(src) * g1 + f2.bp(src) * g2 + f3.bp(src) * g3;
        seed = (Math.imul(seed, LCG_A) + LCG_C) | 0;
        const nz = seed * I2F;
        if (cEnv > 1e-5) { s += (plosive ? cf.bp(nz) : cf.hp(nz)) * cEnv; cEnv -= cC * cEnv; }
        if (this.bNow > 0) s += bf.bp(nz) * this.bNow;
        if (sub > 0 || th > 1e-5) {
          pS += inc * 0.5; if (pS >= 1) pS -= 1;
          s += SINT[(pS * SIN_N) | 0] * (sub + th);
          th -= thC * th;
        }
        out[i] = s * env.next();
        if (env.stage === 0) { this.on = false; i++; break; }
      }
      this.p = p; this.pS = pS; this.c = c; this.seed = seed; this.cEnv = cEnv; this.th = th;
      return i;
    }
  }

  /** FM: a table carrier (a sine when ta = 0) bent by a sine modulator whose index falls over the note. Also the bell of the rite. */
  class FmVoice extends Voice {
    constructor(sr) {
      super(sr);
      this.env = new Env(); this.svf = new SVF(); this.t = null;
      this.p = 0; this.pM = 0; this.pS = 0; this.inc = 0; this.incNow = 0; this.gl8 = 1; this.glC = 0;
      this.ratio = 2; this.ix = 0; this.ixTo = 0; this.ixC = 0; this.lpOn = false; this.sub = 0; this.c = 0;
    }
    init(K, e, o) {
      const sr = this.sr, X = FmVoice.X, P = o + EV.P, f = e[o + EV.FREQ], from = e[o + EV.FROM];
      this.t = K.table(e[o + EV.TA], f);
      this.inc = inc01(f, sr);
      this.gl8 = from > 0 ? from / f : 1;
      this.glC = 1 - Math.exp(-CTL / (0.03 * sr));
      this.incNow = Math.min(0.49, this.inc * this.gl8);
      this.ratio = e[P + X.ratio];
      this.ix = e[P + X.index] / sr;               // deviation, in cycles per sample
      this.ixTo = this.ix * e[P + X.indexEnd];
      this.ixC = lag(Math.max(0.005, e[P + X.indexTau]), sr);
      const cut = e[P + X.cut];
      this.lpOn = cut > 0 && cut < sr * 0.4;
      this.svf.reset();
      if (this.lpOn) this.svf.set(cut, 0.6, sr);
      this.sub = e[P + X.sub];
      this.p = 0; this.pM = 0; this.pS = 0; this.c = 0;
      this.env.start(sr, e[P + X.a], e[P + X.d], e[P + X.s], e[P + X.r], e[P + X.peak] * e[o + EV.VEL]);
    }
    release() { this.env.release(); }
    render(out, from, to) {
      const t = this.t, env = this.env, svf = this.svf, ratio = this.ratio, ixTo = this.ixTo, ixC = this.ixC, sub = this.sub, lpOn = this.lpOn;
      let p = this.p, pM = this.pM, pS = this.pS, ix = this.ix, inc = this.incNow, c = this.c, i = from;
      for (; i < to; i++) {
        if ((c++ & 15) === 0 && this.gl8 !== 1) {
          this.gl8 += this.glC * (1 - this.gl8);
          if (Math.abs(this.gl8 - 1) < 1e-4) this.gl8 = 1;
          inc = this.incNow = Math.min(0.49, this.inc * this.gl8);
        }
        pM += inc * ratio; if (pM >= 1) pM -= Math.floor(pM);
        ix += ixC * (ixTo - ix);
        p += inc + SINT[(pM * SIN_N) | 0] * ix;
        p -= Math.floor(p); if (p >= 1) p = 0;     // floor of a tiny negative can round to exactly 1
        const x = p * TLEN, j = x | 0;
        let s = t[j] + (t[j + 1] - t[j]) * (x - j);
        if (lpOn) s = svf.lp(s);
        if (sub > 0) { pS += inc * 0.5; if (pS >= 1) pS -= 1; s += SINT[(pS * SIN_N) | 0] * sub; }
        out[i] = s * env.next();
        if (env.stage === 0) { this.on = false; i++; break; }
      }
      this.p = p; this.pM = pM; this.pS = pS; this.ix = ix; this.c = c;
      return i;
    }
  }

  /** Bow: two detuned cells under a slow swell; slow noise on the cutoff stands in for bow pressure. */
  class BowVoice extends Voice {
    constructor(sr) {
      super(sr);
      this.env = new Env(); this.svf = new SVF(); this.t = null;
      this.p1 = 0; this.p2 = 0; this.i1 = 0; this.i2 = 0; this.gl8 = 1; this.glC = 0;
      this.cut = 0; this.cutTo = 0; this.cutInc = 0; this.q = 1.6; this.wob = 0; this.wobAmt = 0; this.wobC = 0; this.c = 0;
    }
    init(K, e, o, spb) {
      const sr = this.sr, X = BowVoice.X, P = o + EV.P;
      const f = e[o + EV.FREQ], from = e[o + EV.FROM], d = K.secs(e[o + EV.DUR], spb);
      const det = Math.pow(2, e[P + X.det] / 1200);
      this.t = K.table(e[o + EV.TA], f);
      this.i1 = inc01(f / det, sr); this.i2 = inc01(f * det, sr);
      this.gl8 = from > 0 ? from / f : 1;
      this.glC = 1 - Math.exp(-CTL / (0.045 * sr));
      this.cutTo = e[P + X.cut]; this.cut = this.cutTo * 0.5;
      this.cutInc = (this.cutTo * 0.5 * CTL) / (Math.min(0.5, d * 0.5) * sr);
      this.q = e[P + X.q];
      this.wob = 0; this.wobAmt = e[P + X.wob]; this.wobC = 1 - Math.exp((-TAU * 9 * CTL) / sr);
      this.p1 = (this.seed >>> 8) / 16777216; this.p2 = 0; this.c = 0;
      this.svf.reset();
      this.env.start(sr, e[P + X.a], e[P + X.d], e[P + X.s], e[P + X.r], e[P + X.peak] * e[o + EV.VEL]);
    }
    release() { this.env.release(); }
    render(out, from, to) {
      const t = this.t, env = this.env, svf = this.svf, sr = this.sr;
      let p1 = this.p1, p2 = this.p2, c = this.c, seed = this.seed, g = this.gl8, i = from;
      for (; i < to; i++) {
        if ((c++ & 15) === 0) {
          if (g !== 1) { g += this.glC * (1 - g); if (Math.abs(g - 1) < 1e-4) g = 1; }
          if (this.cut < this.cutTo) this.cut += this.cutInc;
          seed = (Math.imul(seed, LCG_A) + LCG_C) | 0;
          this.wob += this.wobC * (seed * I2F - this.wob);
          svf.set(this.cut * (1 + this.wob * this.wobAmt), this.q, sr);
        }
        p1 += this.i1 * g; if (p1 >= 1) p1 -= 1;
        p2 += this.i2 * g; if (p2 >= 1) p2 -= 1;
        const x = p1 * TLEN, j = x | 0, y = p2 * TLEN, k = y | 0;
        const s = t[j] + (t[j + 1] - t[j]) * (x - j) + t[k] + (t[k + 1] - t[k]) * (y - k);
        out[i] = svf.lp(s) * env.next();
        if (env.stage === 0) { this.on = false; i++; break; }
      }
      this.p1 = p1; this.p2 = p2; this.c = c; this.seed = seed; this.gl8 = g;
      return i;
    }
  }

  /** Bell: the cell struck, with inharmonic partners at 2.76× and 3.01×, each decaying at its own rate. */
  class BellVoice extends Voice {
    constructor(sr) {
      super(sr);
      this.t = null;
      this.p0 = 0; this.p1 = 0; this.p2 = 0; this.p3 = 0; this.i0 = 0; this.i1 = 0; this.i2 = 0; this.i3 = 0;
      this.a0 = 0; this.a1 = 0; this.a2 = 0; this.a3 = 0; this.d0 = 0; this.d1 = 0; this.d2 = 0; this.d3 = 0;
      this.amp = 0; this.atk = 0; this.atkInc = 0; this.life = 0; this.kill = 1; this.killM = 0;
    }
    init(K, e, o) {
      const sr = this.sr, X = BellVoice.X, P = o + EV.P, f = e[o + EV.FREQ], lim = sr * 0.45;
      const ring = Math.max(0.2, e[P + X.ring]), br = e[P + X.bright], sub = e[P + X.sub];
      this.t = K.table(e[o + EV.TA], f);
      this.hold = Infinity;                        // a bell is struck; the note's written length does not damp it
      this.i0 = inc01(f, sr); this.i1 = inc01(f * 2.76, sr); this.i2 = inc01(f * 3.01, sr); this.i3 = inc01(f * 0.5, sr);
      this.a0 = 0.5;
      this.a1 = f * 2.76 < lim ? 0.22 * (0.4 + br) : 0;
      this.a2 = f * 3.01 < lim ? 0.1 * (0.3 + br) : 0;
      this.a3 = sub > 0 ? sub * 0.3 : 0;
      this.d0 = fall(ring * 0.45, sr); this.d1 = fall(ring * 0.3, sr); this.d2 = fall(ring * 0.18, sr); this.d3 = fall(ring * 0.6, sr);
      this.amp = e[o + EV.VEL] * e[P + X.peak];
      this.atk = 0; this.atkInc = 1 / (0.004 * sr);
      this.life = Math.round((ring + 0.4) * sr); this.kill = 1; this.killM = fall(0.03, sr);
      this.p0 = 0; this.p1 = 0; this.p2 = 0; this.p3 = 0;
    }
    release() { this.life = 0; this.killM = fall(0.06, this.sr); }
    render(out, from, to) {
      const t = this.t, i0 = this.i0, i1 = this.i1, i2 = this.i2, i3 = this.i3, d0 = this.d0, d1 = this.d1, d2 = this.d2, d3 = this.d3;
      const amp = this.amp, atkInc = this.atkInc, killM = this.killM;
      let p0 = this.p0, p1 = this.p1, p2 = this.p2, p3 = this.p3, a0 = this.a0, a1 = this.a1, a2 = this.a2, a3 = this.a3;
      let atk = this.atk, life = this.life, kill = this.kill, i = from;
      for (; i < to; i++) {
        p0 += i0; if (p0 >= 1) p0 -= 1;
        p1 += i1; if (p1 >= 1) p1 -= 1;
        p2 += i2; if (p2 >= 1) p2 -= 1;
        const x = p0 * TLEN, j = x | 0;
        let s = (t[j] + (t[j + 1] - t[j]) * (x - j)) * a0 + SINT[(p1 * SIN_N) | 0] * a1 + SINT[(p2 * SIN_N) | 0] * a2;
        if (a3 > 0) { p3 += i3; if (p3 >= 1) p3 -= 1; s += SINT[(p3 * SIN_N) | 0] * a3; a3 *= d3; }
        a0 *= d0; a1 *= d1; a2 *= d2;
        if (atk < 1) { s *= atk; atk += atkInc; }
        if (life > 0) life--; else kill *= killM;
        out[i] = s * amp * kill;
        if (kill < 0.001 || a0 < 1e-5) { this.on = false; i++; break; }
      }
      this.p0 = p0; this.p1 = p1; this.p2 = p2; this.p3 = p3; this.a0 = a0; this.a1 = a1; this.a2 = a2; this.a3 = a3;
      this.atk = atk; this.life = life; this.kill = kill;
      return i;
    }
  }

  /** Drone: a fifth and a sub-octave through a slowly breathing low-pass. Releases one second before its written end. */
  class DroneVoice extends Voice {
    constructor(sr) {
      super(sr);
      this.env = new Env(); this.svf = new SVF(); this.tA = null; this.tB = null;
      this.p1 = 0; this.p2 = 0; this.pS = 0; this.pL = 0; this.i1 = 0; this.i2 = 0; this.iS = 0; this.lInc = 0;
      this.cut = 320; this.lfo = 140; this.c = 0;
    }
    init(K, e, o) {
      const sr = this.sr, X = DroneVoice.X, P = o + EV.P, f = e[o + EV.FREQ];
      this.tA = K.table(e[o + EV.TA], f); this.tB = K.table(e[o + EV.TB], f * 1.5);
      this.i1 = inc01(f, sr); this.i2 = inc01(f * 1.5018, sr); this.iS = inc01(f * 0.5, sr);
      this.cut = e[P + X.cut]; this.lfo = e[P + X.lfo];
      this.pL = 0; this.lInc = (0.06 * CTL) / sr;
      this.p1 = 0; this.p2 = 0.31; this.pS = 0; this.c = 0;
      this.svf.reset();
      if (this.hold !== Infinity) this.hold = Math.max(1, this.hold - Math.round(sr));
      this.env.start(sr, Math.max(0.05, e[P + X.a]), 1, 1, Math.max(0.05, e[P + X.rel]), e[P + X.peak] * e[o + EV.VEL]);
    }
    release() { this.env.release(); }
    render(out, from, to) {
      const tA = this.tA, tB = this.tB, env = this.env, svf = this.svf, i1 = this.i1, i2 = this.i2, iS = this.iS;
      let p1 = this.p1, p2 = this.p2, pS = this.pS, c = this.c, i = from;
      for (; i < to; i++) {
        if ((c++ & 15) === 0) {
          this.pL += this.lInc; if (this.pL >= 1) this.pL -= 1;
          svf.set(this.cut + this.lfo * SINT[(this.pL * SIN_N) | 0], 3, this.sr);
        }
        p1 += i1; if (p1 >= 1) p1 -= 1;
        p2 += i2; if (p2 >= 1) p2 -= 1;
        pS += iS; if (pS >= 1) pS -= 1;
        const x = p1 * TLEN, j = x | 0, y = p2 * TLEN, k = y | 0;
        const s = (tA[j] + (tA[j + 1] - tA[j]) * (x - j)) * 0.5 + (tB[k] + (tB[k + 1] - tB[k]) * (y - k)) * 0.3
                + SINT[(pS * SIN_N) | 0] * 0.3;
        out[i] = svf.lp(s) * env.next();
        if (env.stage === 0) { this.on = false; i++; break; }
      }
      this.p1 = p1; this.p2 = p2; this.pS = pS; this.c = c;
      return i;
    }
  }

  /** Kick: a body that glides into the root, a sub that holds it, a harmonic for small speakers, a beater click, a shaper. */
  class KickVoice extends Voice {
    constructor(sr) {
      super(sr);
      this.svf = new SVF();
      this.p1 = 0; this.p2 = 0; this.p3 = 0; this.inc = 0; this.r = 1; this.rM = 1;
      this.aB = 0; this.dB = 0; this.aS = 0; this.dS = 0; this.sHold = 0; this.aH = 0; this.dH = 0; this.aC = 0; this.dC = 0;
      this.amp = 0; this.atk = 0; this.atkInc = 0;
    }
    init(K, e, o) {
      const sr = this.sr, X = KickVoice.X, P = o + EV.P;
      this.hold = Infinity;
      this.inc = Math.min(e[o + EV.FREQ] / sr, 0.05);
      const gl = clamp(e[P + X.glide], 1, 8), gT = Math.max(0.002, e[P + X.glideT]), dec = Math.max(0.02, e[P + X.decay]);
      this.r = gl; this.rM = Math.pow(gl, -1 / (gT * sr));
      this.aB = 0.85; this.dB = fall(dec * 0.3, sr);
      this.aS = 0.9 * e[P + X.sub]; this.dS = fall(dec * 0.9, sr); this.sHold = Math.round(0.02 * sr);
      this.aH = 0.22 * e[P + X.sub] + 0.08; this.dH = fall(Math.max(0.01, e[P + X.harm]), sr);
      this.aC = 0.45 * e[P + X.click]; this.dC = fall(0.004, sr);
      this.svf.reset(); this.svf.set(e[P + X.clickF], 1.1, sr);
      this.amp = e[o + EV.VEL] * 0.9 * 1.8;          // level into the shaper
      this.atk = 0; this.atkInc = 1 / (0.002 * sr);
      this.p1 = 0; this.p2 = 0; this.p3 = 0;
    }
    render(out, from, to) {
      const svf = this.svf, inc = this.inc, rM = this.rM, dB = this.dB, dS = this.dS, dH = this.dH, dC = this.dC, amp = this.amp, atkInc = this.atkInc;
      let p1 = this.p1, p2 = this.p2, p3 = this.p3, r = this.r, aB = this.aB, aS = this.aS, aH = this.aH, aC = this.aC;
      let sHold = this.sHold, atk = this.atk, seed = this.seed, i = from;
      for (; i < to; i++) {
        if (r > 1) { r *= rM; if (r < 1) r = 1; }
        p1 += inc * r; if (p1 >= 1) p1 -= 1;
        p2 += inc; if (p2 >= 1) p2 -= 1;
        p3 += inc * 2.01; if (p3 >= 1) p3 -= 1;
        let s = SINT[(p1 * SIN_N) | 0] * aB + SINT[(p2 * SIN_N) | 0] * aS + (4 * Math.abs(p3 - 0.5) - 1) * aH;
        aB *= dB; aH *= dH;
        if (sHold > 0) sHold--; else aS *= dS;
        if (aC > 1e-4) { seed = (Math.imul(seed, LCG_A) + LCG_C) | 0; s += svf.bp(seed * I2F) * aC; aC *= dC; }
        if (atk < 1) { s *= atk; atk += atkInc; }
        s *= amp;
        s = s > 3 ? 3 : s < -3 ? -3 : s;
        out[i] = ((s * (27 + s * s)) / (27 + 9 * s * s)) * SAT_NORM;     // a cheap tanh
        if (aB < 1e-4 && aS < 1e-4) { this.on = false; i++; break; }
      }
      this.p1 = p1; this.p2 = p2; this.p3 = p3; this.r = r; this.aB = aB; this.aS = aS; this.aH = aH; this.aC = aC;
      this.sHold = sHold; this.atk = atk; this.seed = seed;
      return i;
    }
  }

  /** Snare: a tuned body, a noise band, a crack, and an optional rim click. */
  class SnareVoice extends Voice {
    constructor(sr) {
      super(sr);
      this.nf = new SVF(); this.sf = new SVF();
      this.p1 = 0; this.p2 = 0; this.p3 = 0; this.inc = 0; this.iR = 0; this.r = 1; this.rM = 1;
      this.aB = 0; this.dB = 0; this.aO = 0; this.dO = 0; this.aN = 0; this.dN = 0; this.aC = 0; this.dC = 0; this.aR = 0; this.dR = 0;
      this.amp = 0;
    }
    init(K, e, o) {
      const sr = this.sr, X = SnareVoice.X, P = o + EV.P;
      this.hold = Infinity;
      this.inc = Math.min(e[o + EV.FREQ] / sr, 0.2);
      this.r = 1.4; this.rM = Math.pow(1.4, -1 / (0.03 * sr));
      const body = e[P + X.body], bd = Math.max(0.004, e[P + X.bodyDec]);
      this.aB = body; this.dB = fall(bd, sr);
      this.aO = body * 0.22; this.dO = fall(bd * 0.7, sr);
      this.aN = e[P + X.noise]; this.dN = fall(e[P + X.noiseDec], sr);
      this.aC = e[P + X.snap]; this.dC = fall(0.007, sr);
      this.aR = e[P + X.rim] > 0 ? 0.3 : 0; this.dR = fall(0.012, sr); this.iR = 1700 / sr;
      this.nf.reset(); this.sf.reset();
      this.nf.set(e[P + X.toneF], 0.7, sr); this.sf.set(e[P + X.snapF], 0.6, sr);
      this.amp = e[o + EV.VEL];
      this.p1 = 0; this.p2 = 0; this.p3 = 0;
    }
    render(out, from, to) {
      const nf = this.nf, sf = this.sf, inc = this.inc, rM = this.rM, amp = this.amp, iR = this.iR;
      const dB = this.dB, dO = this.dO, dN = this.dN, dC = this.dC, dR = this.dR;
      let p1 = this.p1, p2 = this.p2, p3 = this.p3, r = this.r, aB = this.aB, aO = this.aO, aN = this.aN, aC = this.aC, aR = this.aR;
      let seed = this.seed, i = from;
      for (; i < to; i++) {
        if (r > 1) { r *= rM; if (r < 1) r = 1; }
        p1 += inc * r; if (p1 >= 1) p1 -= 1;
        p2 += inc * 2; if (p2 >= 1) p2 -= 1;
        let s = (4 * Math.abs(p1 - 0.5) - 1) * aB + SINT[(p2 * SIN_N) | 0] * aO;
        seed = (Math.imul(seed, LCG_A) + LCG_C) | 0;
        const nz = seed * I2F;
        s += nf.bp(nz) * aN;
        if (aC > 1e-4) { s += sf.hp(nz) * aC; aC *= dC; }
        if (aR > 1e-4) { p3 += iR; if (p3 >= 1) p3 -= 1; s += (4 * Math.abs(p3 - 0.5) - 1) * aR; aR *= dR; }
        aB *= dB; aO *= dO; aN *= dN;
        out[i] = s * amp;
        if (aB < 1e-4 && aN < 1e-4) { this.on = false; i++; break; }
      }
      this.p1 = p1; this.p2 = p2; this.p3 = p3; this.r = r; this.aB = aB; this.aO = aO; this.aN = aN; this.aC = aC; this.aR = aR;
      this.seed = seed;
      return i;
    }
  }

  /** Hat / metal: a cluster of square partials through a high-pass, plus a noise band. Also the crash's shimmer. */
  class HatVoice extends Voice {
    constructor(sr) {
      super(sr);
      this.hp = new SVF(); this.bp = new SVF();
      this.ph = new Float64Array(6); this.inc = new Float64Array(6); this.np = 0;
      this.nz = 0.3; this.a = 0; this.rise = true; this.aInc = 0; this.dM = 0; this.amp = 0;
    }
    init(K, e, o) {
      const sr = this.sr, X = HatVoice.X, P = o + EV.P;
      this.hold = Infinity;
      const set = HAT_SETS[clamp(e[P + X.metal] | 0, 0, 3)];
      this.np = set ? clamp(e[P + X.parts] | 0, 1, 6) : 0;
      const base = e[P + X.baseF];
      for (let k = 0; k < this.np; k++) { this.inc[k] = inc01(base * set[k], sr); this.ph[k] = k * 0.13; }
      this.hp.reset(); this.bp.reset();
      this.hp.set(e[P + X.hpF], 0.6, sr); this.bp.set(e[P + X.bpF], 1.1, sr);
      this.nz = e[P + X.noise];
      this.a = 0; this.rise = true; this.aInc = 1 / (0.001 * sr); this.dM = fall(e[P + X.decay], sr);
      this.amp = e[o + EV.VEL];
    }
    render(out, from, to) {
      const hp = this.hp, bp = this.bp, ph = this.ph, inc = this.inc, np = this.np, nzLvl = this.nz, dM = this.dM, aInc = this.aInc, amp = this.amp;
      let a = this.a, rise = this.rise, seed = this.seed, i = from;
      for (; i < to; i++) {
        let s = 0;
        if (np > 0) {
          let sq = 0;
          for (let k = 0; k < np; k++) { let p = ph[k] + inc[k]; if (p >= 1) p -= 1; ph[k] = p; sq += p < 0.5 ? 1 : -1; }
          s = hp.hp(sq * 0.06);
        }
        if (nzLvl > 0) { seed = (Math.imul(seed, LCG_A) + LCG_C) | 0; s += bp.bp(seed * I2F) * nzLvl; }
        if (rise) { a += aInc; if (a >= 1) { a = 1; rise = false; } } else a *= dM;
        out[i] = s * a * amp;
        if (!rise && a < 1e-4) { this.on = false; i++; break; }
      }
      this.a = a; this.rise = rise; this.seed = seed;
      return i;
    }
  }
  class PluckVoice extends Voice {
    constructor(sr) { super(sr); this.env = new Env(); this.p = 0; this.inc = 0; }
    init(K, e, o, spb) {
      const X = PluckVoice.X, P = o + EV.P;
      this.inc = inc01(e[o + EV.FREQ], this.sr); this.p = 0;
      this.env.start(this.sr, 0.002, e[P + X.decay], 0, 0.05, e[P + X.peak] * e[o + EV.VEL]);
    }
    release() { this.env.release(); }
    render(out, from, to) {
      let p = this.p, i = from;
      for (; i < to; i++) {
        p += this.inc; if (p >= 1) p -= 1;
        out[i] = SINT[(p * SIN_N) | 0] * this.env.next();
        if (this.env.stage === 0) { this.on = false; i++; break; }
      }
      this.p = p;
      return i;
    }
  }
  define('pluck', PluckVoice, 12, { decay: 0.2, peak: 0.3 });

  /**
   * Noise: one filtered burst. Covers shaker, crash wash, swell, quill tick and fire.
   *   type   0 low-pass · 1 band-pass · 2 high-pass
   *   shape  0 strike (linear attack, exponential decay)
   *          1 swell  (rises across the note, then drops in 20 ms)
   *          2 arc    (linear attack, linear decay)
   */
  class NoiseVoice extends Voice {
    constructor(sr) {
      super(sr);
      this.svf = new SVF();
      this.type = 1; this.f = 1000; this.fM = 1; this.q = 1; this.shape = 0;
      this.a = 0; this.st = 0; this.aInc = 0; this.dM = 0; this.dDec = 0; this.amp = 0; this.c = 0;
    }
    init(K, e, o, spb) {
      const sr = this.sr, X = NoiseVoice.X, P = o + EV.P, d = K.secs(e[o + EV.DUR], spb);
      this.hold = Infinity;
      this.type = e[P + X.type] | 0; this.f = e[P + X.f0]; this.q = e[P + X.q] > 0 ? e[P + X.q] : 0.7;
      this.shape = e[P + X.shape] | 0;
      const f1 = e[P + X.f1], atk = Math.max(0.0005, e[P + X.attack]), dec = Math.max(0.001, e[P + X.decay]);
      this.fM = f1 > 0 && f1 !== this.f && this.f > 0 ? Math.pow(f1 / this.f, CTL / (d * sr)) : 1;
      this.a = 0; this.st = 0;
      if (this.shape === 1) { this.aInc = 1 / (Math.max(0.03, d - 0.02) * sr); this.dDec = 1 / (0.02 * sr); }
      else { this.aInc = 1 / (atk * sr); this.dM = fall(dec, sr); this.dDec = 1 / (dec * sr); }
      this.amp = e[o + EV.VEL];
      this.svf.reset(); this.svf.set(this.f, this.q, sr);
      this.c = 0;
    }
    render(out, from, to) {
      const svf = this.svf, type = this.type, lin = this.shape !== 0, aInc = this.aInc, dM = this.dM, dDec = this.dDec, amp = this.amp;
      let a = this.a, st = this.st, seed = this.seed, c = this.c, i = from;
      for (; i < to; i++) {
        if ((c++ & 15) === 0 && this.fM !== 1) { this.f *= this.fM; svf.set(this.f, this.q, this.sr); }
        seed = (Math.imul(seed, LCG_A) + LCG_C) | 0;
        const nz = seed * I2F;
        const s = type === 1 ? svf.bp(nz) : type === 2 ? svf.hp(nz) : svf.lp(nz);
        if (st === 0) { a += aInc; if (a >= 1) { a = 1; st = 1; } }
        else if (lin) a -= dDec;
        else a *= dM;
        out[i] = s * a * amp;
        if (st === 1 && a < 1e-4) { this.on = false; i++; break; }
      }
      this.a = a; this.st = st; this.seed = seed; this.c = c;
      return i;
    }
  }

  /* ── §K5 INSTRUMENT REGISTRY ────────────────────────────────────────────
     define(name, Class, polyphony, { parameter: default, … })
     The parameter ORDER is the event layout (EV.P + index). Inside the class,
     read them by name through Class.X. At most NP (11) per instrument, and no
     parameter may share a name with a common field (beat, bus, freq, from,
     dur, vel, pan, ta, tb, duck, duckLen).
     ─────────────────────────────────────────────────────────────────────── */
  const KINDS = [];
  const KIND = {};
  function define(name, Cls, poly, params) {
    const names = Object.keys(params);
    if (names.length > NP) throw new Error(`instrument "${name}" declares ${names.length} parameters; the event layout holds ${NP}`);
    const ix = {};
    names.forEach((n, i) => (ix[n] = i));
    Cls.X = ix;
    KIND[name] = KINDS.length;
    KINDS.push({ id: KINDS.length, name, Cls, poly, names, defaults: names.map((n) => params[n]) });
  }

  define('wave',  WaveVoice,  40, { cut: 4000, cutEnd: 0.4, q: 0.7, sub: 0, a: 0.012, d: 0.083, s: 0.78, r: 0.073, peak: 0.32, vib: 0, cutTau: 0.3 });
  define('vox',   VoxVoice,   8,  { v0: 0, v1: 0, throat: 1, q: 9, cons: 2, consLvl: 0.08, consF: 3600, breath: 0.012, sub: 0, peak: 0.42, vib: 0.006 });
  define('fm',    FmVoice,    16, { ratio: 2, index: 200, indexEnd: 0.08, indexTau: 0.15, cut: 0, sub: 0, a: 0.005, d: 0.083, s: 0.78, r: 0.073, peak: 0.3 });
  define('bow',   BowVoice,   8,  { cut: 3000, q: 1.6, wob: 0.5, det: 7, a: 0.12, d: 0.1, s: 0.9, r: 0.117, peak: 0.3 });
  define('bell',  BellVoice,  14, { ring: 1.5, bright: 0.6, sub: 0, peak: 0.7 });
  define('drone', DroneVoice, 3,  { cut: 320, lfo: 140, peak: 0.2, a: 2, rel: 1.3 });
  define('kick',  KickVoice,  4,  { glide: 1.7, glideT: 0.09, decay: 0.45, sub: 0.8, click: 0.5, clickF: 2500, harm: 0.08 });
  define('snare', SnareVoice, 6,  { body: 0.5, bodyDec: 0.05, noise: 0.55, noiseDec: 0.1, snap: 0.25, toneF: 1900, snapF: 5500, rim: 0 });
  define('hat',   HatVoice,   10, { decay: 0.03, hpF: 7500, bpF: 10000, metal: 1, baseF: 400, parts: 4, noise: 0.3 });
  define('noise', NoiseVoice, 20, { type: 1, f0: 3000, f1: 0, q: 1, attack: 0.002, decay: 0.05, shape: 0 });

  /* ── §K6 EFFECTS ──────────────────────────────────────────────────────── */

  /** Two slowly modulated taps, panned apart. */
  class Chorus {
    constructor(sr) {
      this.sr = sr;
      let n = 1; while (n < sr * 0.05) n <<= 1;
      this.buf = new Float32Array(n); this.mask = n - 1; this.w = 0; this.p1 = 0; this.p2 = 0.37;
    }
    clear() { this.buf.fill(0); }
    run(inp, L, R, n, wet) {
      const sr = this.sr, buf = this.buf, mask = this.mask, i1 = 0.23 / sr, i2 = 0.31 / sr;
      let w = this.w, p1 = this.p1, p2 = this.p2;
      for (let i = 0; i < n; i++) {
        buf[w] = inp[i] + TINY;
        p1 += i1; if (p1 >= 1) p1 -= 1;
        p2 += i2; if (p2 >= 1) p2 -= 1;
        let x = p1 * SIN_N, j = x | 0;
        const d1 = (0.012 + 0.0035 * (SINT[j] + (SINT[j + 1] - SINT[j]) * (x - j))) * sr;
        x = p2 * SIN_N; j = x | 0;
        const d2 = (0.019 + 0.0028 * (SINT[j] + (SINT[j + 1] - SINT[j]) * (x - j))) * sr;
        let r = w - d1, a = Math.floor(r), fr = r - a;
        const s1 = buf[a & mask] + (buf[(a + 1) & mask] - buf[a & mask]) * fr;
        r = w - d2; a = Math.floor(r); fr = r - a;
        const s2 = buf[a & mask] + (buf[(a + 1) & mask] - buf[a & mask]) * fr;
        L[i] += (s1 * 0.972 + s2 * 0.233) * wet;
        R[i] += (s1 * 0.233 + s2 * 0.972) * wet;
        w = (w + 1) & mask;
      }
      this.w = w; this.p1 = p1; this.p2 = p2;
    }
  }

  /** Stereo feedback echo with a darkening loop. The delay time glides, so a tempo change bends rather than clicks. */
  class Echo {
    constructor(sr) {
      this.sr = sr;
      let n = 1; while (n < sr * 3.1) n <<= 1;
      this.bL = new Float32Array(n); this.bR = new Float32Array(n); this.mask = n - 1;
      this.w = 0; this.d = 0.45 * sr; this.lL = 0; this.lR = 0; this.lpC = 1 - Math.exp((-TAU * 2600) / sr);
    }
    clear() { this.bL.fill(0); this.bR.fill(0); this.lL = 0; this.lR = 0; }
    run(inL, inR, L, R, rvL, rvR, n, time, fb, ret) {
      const bL = this.bL, bR = this.bR, mask = this.mask, lpC = this.lpC, toRev = MIX.echoToReverb;
      const target = clamp(time * this.sr, 8, mask - 8);
      let w = this.w, d = this.d, lL = this.lL, lR = this.lR;
      for (let i = 0; i < n; i++) {
        d += (target - d) * 0.0004;
        const x = w - d, a = Math.floor(x), fr = x - a, i0 = a & mask, i1 = (a + 1) & mask;
        lL += lpC * (bL[i0] + (bL[i1] - bL[i0]) * fr - lL);
        lR += lpC * (bR[i0] + (bR[i1] - bR[i0]) * fr - lR);
        bL[w] = inL[i] + lL * fb + TINY;
        bR[w] = inR[i] + lR * fb + TINY;
        w = (w + 1) & mask;
        const oL = lL * ret, oR = lR * ret;
        L[i] += oL; R[i] += oR;
        rvL[i] += oL * toRev; rvR[i] += oR * toRev;
      }
      this.w = w; this.d = d; this.lL = lL; this.lR = lR;
    }
  }

  /**
   * Reverb: pre-delay → early reflections (taps from the sigil's strokes) → two
   * diffusers → an eight-line feedback delay network with a Hadamard mix.
   * Far cheaper than convolution, and its decay and colour can change live.
   */
  const REV_MS = [31.7, 37.9, 43.3, 50.1, 58.7, 67.3, 76.9, 88.3];
  const H8 = 1 / Math.sqrt(8);
  class Reverb {
    constructor(sr) {
      this.sr = sr;
      this.len = new Int32Array(8); this.buf = []; this.idx = new Int32Array(8);
      this.g = new Float64Array(8); this.lp = new Float64Array(8);
      for (let i = 0; i < 8; i++) {
        this.len[i] = Math.round((REV_MS[i] * sr) / 1000) | 1;
        this.buf.push(new Float32Array(this.len[i]));
      }
      let n = 1; while (n < sr * 1.5) n <<= 1;
      this.pre = new Float32Array(n); this.pmask = n - 1; this.pw = 0; this.preN = Math.round(0.018 * sr);
      this.tapN = 0; this.tapD = new Int32Array(32); this.tapL = new Float32Array(32); this.tapR = new Float32Array(32);
      this.ap1 = new Float32Array(Math.round(0.0047 * sr) | 1); this.ap2 = new Float32Array(Math.round(0.0067 * sr) | 1);
      this.x1 = 0; this.x2 = 0;
      this.dampC = 0.5; this.norm = 0.12;
      this.set(3.1, 0.5, 0.018, null);
    }
    clear() {
      for (const b of this.buf) b.fill(0);
      this.pre.fill(0); this.ap1.fill(0); this.ap2.fill(0); this.lp.fill(0);
    }
    /** rt60 seconds · bright 0…1 (how much treble survives each pass) · pre-delay seconds · taps [[seconds, gain, pan]…] */
    set(rt60, bright, pre, taps) {
      const sr = this.sr;
      rt60 = clamp(rt60, 0.2, 12);
      let g2 = 0;
      for (let i = 0; i < 8; i++) { this.g[i] = Math.pow(10, (-3 * this.len[i]) / (rt60 * sr)); g2 += this.g[i] * this.g[i]; }
      this.norm = 0.25 * Math.sqrt(Math.max(0.02, 1 - g2 / 8));     // keeps loudness roughly constant as the decay changes
      this.dampC = 1 - Math.exp((-TAU * (1800 + 9000 * clamp(bright, 0, 1))) / sr);
      this.preN = clamp(Math.round(pre * sr), 1, this.pmask - 1);
      this.tapN = 0;
      if (taps) {
        for (const t of taps) {
          if (this.tapN >= 32) break;
          const d = Math.round(t[0] * sr);
          if (!(d >= 1 && d < this.pmask)) continue;
          const pan = clamp(num(t[2], 0), -1, 1), gain = num(t[1], 0);
          this.tapD[this.tapN] = d;
          this.tapL[this.tapN] = gain * (pan > 0 ? 1 - pan : 1);
          this.tapR[this.tapN] = gain * (pan < 0 ? 1 + pan : 1);
          this.tapN++;
        }
      }
    }
    run(inL, inR, L, R, n, wet) {
      const pre = this.pre, pm = this.pmask, tapN = this.tapN, tapD = this.tapD, tapL = this.tapL, tapR = this.tapR, preN = this.preN;
      const ap1 = this.ap1, ap2 = this.ap2, A1 = ap1.length, A2 = ap2.length;
      const b = this.buf, len = this.len, g = this.g, lp = this.lp, idx = this.idx;
      const b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3], b4 = b[4], b5 = b[5], b6 = b[6], b7 = b[7];
      const q0 = len[0], q1 = len[1], q2 = len[2], q3 = len[3], q4 = len[4], q5 = len[5], q6 = len[6], q7 = len[7];
      const g0 = g[0], g1 = g[1], g2 = g[2], g3 = g[3], g4 = g[4], g5 = g[5], g6 = g[6], g7 = g[7];
      const dc = this.dampC, norm = this.norm * wet, er = MIX.early * wet;
      let i0 = idx[0], i1 = idx[1], i2 = idx[2], i3 = idx[3], i4 = idx[4], i5 = idx[5], i6 = idx[6], i7 = idx[7];
      let l0 = lp[0], l1 = lp[1], l2 = lp[2], l3 = lp[3], l4 = lp[4], l5 = lp[5], l6 = lp[6], l7 = lp[7];
      let pw = this.pw, x1 = this.x1, x2 = this.x2;
      for (let i = 0; i < n; i++) {
        pre[pw] = (inL[i] + inR[i]) * 0.5 + TINY;
        let eL = 0, eR = 0;
        for (let t = 0; t < tapN; t++) { const s = pre[(pw - tapD[t]) & pm]; eL += s * tapL[t]; eR += s * tapR[t]; }
        let d = pre[(pw - preN) & pm];
        pw = (pw + 1) & pm;
        let z = ap1[x1], y = z - 0.6 * d; ap1[x1] = d + 0.6 * y; if (++x1 >= A1) x1 = 0; d = y;
        z = ap2[x2]; y = z - 0.6 * d; ap2[x2] = d + 0.6 * y; if (++x2 >= A2) x2 = 0; d = y;
        const a0 = b0[i0], a1 = b1[i1], a2 = b2[i2], a3 = b3[i3], a4 = b4[i4], a5 = b5[i5], a6 = b6[i6], a7 = b7[i7];
        const s0 = a0 + a1, s1 = a0 - a1, s2 = a2 + a3, s3 = a2 - a3, s4 = a4 + a5, s5 = a4 - a5, s6 = a6 + a7, s7 = a6 - a7;
        const t0 = s0 + s2, t1 = s1 + s3, t2 = s0 - s2, t3 = s1 - s3, t4 = s4 + s6, t5 = s5 + s7, t6 = s4 - s6, t7 = s5 - s7;
        l0 += dc * ((t0 + t4) * H8 - l0); b0[i0] = l0 * g0 + d; if (++i0 >= q0) i0 = 0;
        l1 += dc * ((t1 + t5) * H8 - l1); b1[i1] = l1 * g1 - d; if (++i1 >= q1) i1 = 0;
        l2 += dc * ((t2 + t6) * H8 - l2); b2[i2] = l2 * g2 + d; if (++i2 >= q2) i2 = 0;
        l3 += dc * ((t3 + t7) * H8 - l3); b3[i3] = l3 * g3 - d; if (++i3 >= q3) i3 = 0;
        l4 += dc * ((t0 - t4) * H8 - l4); b4[i4] = l4 * g4 + d; if (++i4 >= q4) i4 = 0;
        l5 += dc * ((t1 - t5) * H8 - l5); b5[i5] = l5 * g5 - d; if (++i5 >= q5) i5 = 0;
        l6 += dc * ((t2 - t6) * H8 - l6); b6[i6] = l6 * g6 + d; if (++i6 >= q6) i6 = 0;
        l7 += dc * ((t3 - t7) * H8 - l7); b7[i7] = l7 * g7 - d; if (++i7 >= q7) i7 = 0;
        L[i] += (a0 + a2 - a4 - a6) * norm + eL * er;
        R[i] += (a1 + a3 - a5 - a7) * norm + eR * er;
      }
      idx[0] = i0; idx[1] = i1; idx[2] = i2; idx[3] = i3; idx[4] = i4; idx[5] = i5; idx[6] = i6; idx[7] = i7;
      lp[0] = l0; lp[1] = l1; lp[2] = l2; lp[3] = l3; lp[4] = l4; lp[5] = l5; lp[6] = l6; lp[7] = l7;
      this.pw = pw; this.x1 = x1; this.x2 = x2;
    }
  }

  /** Drive → fold → bit depth → sample hold, mixed against the clean signal. */
  class Crusher {
    constructor() { this.cnt = 0; this.hL = 0; this.hR = 0; this.seed = 0x2f6e2b1; }
    run(L, R, n, mix, bits, hold, fold, drive) {
      const levels = Math.pow(2, clamp(bits, 2, 16) - 1);
      const k = 1 + drive * 5, norm = drive > 0 ? 1 / Math.tanh(k) : 1;
      const H = Math.max(1, Math.round(hold)), bend = Math.PI * 0.5 * (1 + 3 * fold);
      let cnt = this.cnt, hL = this.hL, hR = this.hR, seed = this.seed;
      for (let i = 0; i < n; i++) {
        if (cnt === 0) {
          let v = L[i];
          if (drive > 0) v = Math.tanh(v * k) * norm;
          if (fold > 0) v = (1 - fold) * v + fold * Math.sin(v * bend);
          v = v < -1 ? -1 : v > 1 ? 1 : v;
          seed = (Math.imul(seed, LCG_A) + LCG_C) | 0;
          hL = Math.round(v * levels + seed * I2F * 0.5) / levels;
          v = R[i];
          if (drive > 0) v = Math.tanh(v * k) * norm;
          if (fold > 0) v = (1 - fold) * v + fold * Math.sin(v * bend);
          v = v < -1 ? -1 : v > 1 ? 1 : v;
          seed = (Math.imul(seed, LCG_A) + LCG_C) | 0;
          hR = Math.round(v * levels + seed * I2F * 0.5) / levels;
        }
        if (++cnt >= H) cnt = 0;
        L[i] += (hL - L[i]) * mix;
        R[i] += (hR - R[i]) * mix;
      }
      this.cnt = cnt; this.hL = hL; this.hR = hR; this.seed = seed;
    }
  }

  /** Stereo-linked feed-forward compressor. The gain curve is evaluated every 16 samples and smoothed between. */
  class Comp {
    constructor(sr, thr, ratio, knee, atk, rel, makeup) {
      this.thr = thr; this.slope = 1 / ratio - 1; this.knee = knee; this.makeup = makeup;
      this.aC = lag(atk, sr); this.rC = lag(rel, sr);
      this.env = 0; this.g = makeup; this.gT = makeup;
    }
    reset() { this.env = 0; this.g = this.makeup; this.gT = this.makeup; }
    run(L, R, n) {
      const aC = this.aC, rC = this.rC, thr = this.thr, slope = this.slope, knee = this.knee, mk = this.makeup;
      let env = this.env, g = this.g, gT = this.gT;
      for (let i = 0; i < n; i++) {
        const l = L[i], r = R[i];
        let a = l < 0 ? -l : l;
        const b = r < 0 ? -r : r;
        if (b > a) a = b;
        env += (a > env ? aC : rC) * (a - env) + TINY;
        if ((i & 15) === 0) {
          const over = 8.685889638 * Math.log(env + 1e-9) - thr;       // dB above threshold
          let gr = 0;
          if (2 * over >= knee) gr = slope * over;
          else if (2 * over > -knee) { const t = over + knee / 2; gr = (slope * t * t) / (2 * knee); }
          gT = Math.exp(gr * 0.1151292546) * mk;
        }
        g += (gT - g) * 0.08;
        L[i] = l * g; R[i] = r * g;
      }
      this.env = env; this.g = g; this.gT = gT;
    }
  }

  /* ── §K7 THE KERNEL ───────────────────────────────────────────────────── */
  class Kernel {
    constructor(sr) {
      this.sr = sr;
      this.post = null;

      /* transport: position is kept in BEATS, so a tempo change needs no re-anchoring */
      this.playing = false; this.looping = true; this.passes = Infinity;
      this.beat = 0; this.spb = 0.6; this.bps = 1 / (0.6 * sr);
      this.ev = new Float64Array(0); this.count = 0; this.ptr = 0; this.total = 16;
      this.region = false; this.rStart = 0; this.rEnd = 0; this.ls = 0; this.le = 16;
      this.scenes = null; this.sceneN = 0; this.sceneAt = -1;
      this.frame = 0; this.epoch = 0; this.seq = 0;
      this.later = [];

      /* tables: 0 = sine, 1 = glottal pulse; the host registers the rest */
      this.tables = new Map();
      const sine = new Float32Array(NT * TROW);
      for (let t = 0; t < NT; t++) {
        for (let i = 0; i < TLEN; i++) sine[t * TROW + i] = Math.sin((TAU * i) / TLEN);
        sine[t * TROW + TLEN] = sine[t * TROW];
      }
      this.setTable(0, sine);
      const gre = new Float32Array(TIERS[0] + 1), gim = new Float32Array(TIERS[0] + 1);
      for (let h = 1; h <= TIERS[0]; h++) gim[h] = 1 / Math.pow(h, 1.5);
      this.setTable(1, buildTables(gre, gim));

      /* voices */
      this.pools = []; this.all = [];
      for (const K of KINDS) {
        const pool = [];
        for (let i = 0; i < K.poly + SPARE; i++) { const v = new K.Cls(sr); pool.push(v); this.all.push(v); }
        this.pools.push(pool);
      }
      this.clock = 0; this.nVoices = 0; this.maxVoices = 72; this.stolen = 0;
      this.stealInc = 1 / (0.006 * sr);

      /* buses and groups */
      this.bRev = new Float32Array(NB); this.bDel = new Float32Array(NB); this.bCho = new Float32Array(NB);
      this.bDest = new Uint8Array(NB); this.bSat = new Uint8Array(NB);
      this.bGain = new Float64Array(NB); this.bPeak = new Float32Array(NB); this.use = new Uint8Array(NB);
      BUS_DEF.forEach((d, b) => {
        this.bGain[b] = d[1]; this.bRev[b] = d[2]; this.bDel[b] = d[3]; this.bCho[b] = d[4]; this.bDest[b] = d[5]; this.bSat[b] = d[6];
      });
      this.cap = 0;
      this.alloc(BLOCK);

      /* parameters */
      this.pv = new Float64Array(NPAR); this.pt = new Float64Array(NPAR); this.ptau = new Float64Array(NPAR);
      this.pmode = new Uint8Array(NPAR); this.pstep = new Float64Array(NPAR); this.pleft = new Float64Array(NPAR);
      PARAM_DEF.forEach((p, i) => { this.pv[i] = p[1]; this.pt[i] = p[1]; this.ptau[i] = p[2]; });
      this.mPrev = this.pv[P_MASTER];

      /* effects */
      this.chorus = new Chorus(sr); this.echo = new Echo(sr); this.reverb = new Reverb(sr); this.crusher = new Crusher();
      this.glue = new Comp(sr, -14, 4, 6, 0.003, 0.12, MIX.drumMakeup);
      this.master = new Comp(sr, -16, 3, 12, 0.008, 0.25, MIX.masterMakeup);
      this.tL = new SVF(); this.tR = new SVF();
      this.dEnv = 0; this.dGoal = 0; this.dAtk = 0; this.dRel = 0; this.dRise = false;

      /* telemetry */
      this.peak = 0; this.faults = 0; this.quiet = 0; this.quietMax = Math.ceil((0.75 * sr) / BLOCK);
    }

    alloc(n) {
      const F = () => new Float32Array(n);
      this.cap = n; this.scratch = F();
      this.busL = []; this.busR = [];
      for (let b = 0; b < NB; b++) { this.busL.push(F()); this.busR.push(F()); }
      this.musL = F(); this.musR = F(); this.drmL = F(); this.drmR = F(); this.pstL = F(); this.pstR = F();
      this.revL = F(); this.revR = F(); this.delL = F(); this.delR = F(); this.cho = F();
    }

    /* ── helpers used by instruments ── */
    /** The band-limited row of table `id` that is safe to play at frequency f. */
    table(id, f) {
      const rows = this.tables.get(id | 0) || this.tables.get(0);
      const lim = this.sr * 0.45;
      for (let i = 0; i < NT; i++) if (TIERS[i] * f < lim) return rows[i];
      return rows[NT - 1];
    }
    /** An event duration in seconds. Held or unspecified notes report 3 s, which only shapes internal sweeps. */
    secs(dur, spb) { return dur > 0 && dur < 1e6 ? Math.max(0.02, dur * spb) : 3; }

    setTable(id, packed) {
      if (!packed || packed.length < NT * TROW) return;
      const rows = [];
      for (let i = 0; i < NT; i++) rows.push(packed.subarray(i * TROW, (i + 1) * TROW));
      this.tables.set(id, rows);
    }

    /* ── parameters ── */
    setParam(name, value, time, mode) {
      const i = typeof name === 'number' ? name : PIX[name];
      if (i === undefined || !(value - value === 0)) return;
      if (mode === 'lin' || mode === 'exp') {
        const len = Math.max(1, (time || 0) * this.sr);
        if (mode === 'exp' && this.pv[i] > 0 && value > 0) { this.pmode[i] = 2; this.pstep[i] = Math.log(value / this.pv[i]) / len; }
        else { this.pmode[i] = 1; this.pstep[i] = (value - this.pv[i]) / len; }
        this.pleft[i] = len; this.pt[i] = value;
        return;
      }
      this.pmode[i] = 0; this.pt[i] = value;
      this.ptau[i] = time === undefined || time === null ? PARAM_DEF[i][2] : time;
      if (!(this.ptau[i] > 0)) this.pv[i] = value;
    }
    tickParams(n) {
      const pv = this.pv, pt = this.pt, sr = this.sr;
      for (let i = 0; i < NPAR; i++) {
        const mode = this.pmode[i];
        if (mode === 0) {
          if (pv[i] === pt[i]) continue;
          const tau = this.ptau[i];
          if (!(tau > 0)) { pv[i] = pt[i]; continue; }
          pv[i] += (pt[i] - pv[i]) * (1 - Math.exp(-n / (tau * sr)));
          if (Math.abs(pt[i] - pv[i]) <= 1e-6 * (1 + Math.abs(pt[i]))) pv[i] = pt[i];
        } else {
          const k = Math.min(n, this.pleft[i]);
          if (mode === 1) pv[i] += this.pstep[i] * k; else pv[i] *= Math.exp(this.pstep[i] * k);
          if ((this.pleft[i] -= k) <= 0) { pv[i] = pt[i]; this.pmode[i] = 0; }
        }
      }
    }

    /* ── transport ── */
    /** Index of the first event at or after `beat`. */
    lower(beat) {
      const ev = this.ev, S = EV.STRIDE;
      let lo = 0, hi = this.count;
      while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m * S] < beat) lo = m + 1; else hi = m; }
      return lo;
    }
    bounds() {
      if (this.region && this.rEnd - this.rStart >= 0.5 && this.rEnd <= this.total + 1e-6) { this.ls = this.rStart; this.le = this.rEnd; }
      else { this.ls = 0; this.le = this.total; }
    }
    /**
     * Move the playhead n samples, starting every event it passes at its exact
     * sample. A loop boundary inside the block is crossed mid-block, so loops
     * are gapless and the wrap lands on the right sample.
     */
    advance(n) {
      const ev = this.ev, S = EV.STRIDE, bps = this.bps, count = this.count;
      let s = 0, beat = this.beat, guard = 0;
      while (s < n && guard++ < 8) {
        let limit = beat + (n - s) * bps, wrap = false;
        if (this.looping && limit >= this.le) { limit = this.le; wrap = true; }
        let p = this.ptr;
        while (p < count) {
          const b = ev[p * S];
          if (b >= limit) break;
          let off = (s + (b - beat) / bps) | 0;
          if (off < 0) off = 0; else if (off >= n) off = n - 1;
          this.spawn(ev, p * S, off, this.spb, 0, 0);
          p++;
        }
        this.ptr = p;
        if (wrap) {
          const used = (limit - beat) / bps;
          if (used > 0) s += used;
          if (this.passes !== Infinity && --this.passes <= 0) { this.looping = false; beat = limit; }
          else { beat = this.ls; this.ptr = this.lower(beat); this.sceneAt = -1; }
          this.seq++;
        } else { beat = limit; s = n; }
      }
      this.beat = beat;
    }
    /** Apply the section's effect settings when the playhead enters it. */
    scene() {
      const sc = this.scenes, S = SC.STRIDE, beat = this.beat;
      let i = 0;
      for (let k = 1; k < this.sceneN; k++) if (sc[k * S] <= beat) i = k;
      if (i === this.sceneAt) return;
      this.sceneAt = i;
      const o = i * S;
      this.setParam(P_CHORUS, sc[o + SC.CHORUS]); this.setParam(P_ECHO, sc[o + SC.ECHO]);
      this.setParam(P_CMIX, sc[o + SC.MIX]); this.setParam(P_CBITS, sc[o + SC.BITS]); this.setParam(P_CHOLD, sc[o + SC.HOLD]);
      this.setParam(P_CFOLD, sc[o + SC.FOLD]); this.setParam(P_CDRIVE, sc[o + SC.DRIVE]);
    }

    /* ── voices ── */
    spawn(e, o, offset, spb, group, id) {
      const kind = e[o + EV.KIND] | 0, pool = this.pools[kind];
      if (!pool) return null;
      let v = null, oldest = null, live = 0;
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i];
        if (!c.on) { if (v === null) v = c; }
        else if (c.fadeInc === 0) { live++; if (oldest === null || c.born < oldest.born) oldest = c; }
      }
      // Over the instrument's polyphony: retire the oldest with a 6 ms fade while a spare voice takes the new note.
      if (v !== null && oldest !== null && live >= KINDS[kind].poly) oldest.fadeInc = this.stealInc;
      if (v === null) { v = oldest || pool[0]; this.stolen++; }
      else { if (this.nVoices >= this.maxVoices) this.retire(); this.nVoices++; }
      const bus = e[o + EV.BUS] | 0, a = (clamp(e[o + EV.PAN], -1, 1) + 1) * 0.7853981633974483;
      v.on = true; v.kind = kind; v.bus = bus >= 0 && bus < NB ? bus : 0;
      v.gl = Math.cos(a) * Math.SQRT2; v.gr = Math.sin(a) * Math.SQRT2;      // unity at the centre
      v.fade = 1; v.fadeInc = 0; v.offset = offset; v.born = ++this.clock; v.group = group; v.id = id;
      const dur = e[o + EV.DUR];
      v.hold = dur > 0 && dur < 1e6 ? Math.max(1, Math.round(dur * spb * this.sr)) : Infinity;
      v.seed = (Math.imul(Math.round(e[o + EV.BEAT] * 960) | 0, 2654435761) ^ Math.imul(kind + 1, 40503) ^ Math.round(e[o + EV.FREQ] * 16)) | 1;
      v.init(this, e, o, spb);
      const duck = e[o + EV.DUCK];
      if (duck > 0) this.duckHit(duck, e[o + EV.DUCKLEN]);
      return v;
    }
    /** The global voice ceiling was reached: fade the oldest voice of the score. */
    retire() {
      let oldest = null;
      for (let i = 0; i < this.all.length; i++) {
        const c = this.all[i];
        if (c.on && c.group === 0 && c.fadeInc === 0 && (oldest === null || c.born < oldest.born)) oldest = c;
      }
      if (oldest) oldest.fadeInc = this.stealInc;
    }
    fadeGroup(group, seconds) {
      const inc = 1 / (Math.max(0.003, seconds) * this.sr);
      for (let i = 0; i < this.all.length; i++) {
        const v = this.all[i];
        if (v.on && v.group === group && (v.fadeInc === 0 || inc > v.fadeInc)) v.fadeInc = inc;
      }
    }
    /** Sidechain: dip the music by `amount`, recover over `len` seconds. */
    duckHit(amount, len) {
      amount *= this.pv[P_DUCK];
      if (amount > 0.95) amount = 0.95;
      if (amount <= this.dEnv || amount < 0.001) return;
      this.dGoal = amount; this.dRise = true;
      this.dAtk = amount / (0.005 * this.sr);
      this.dRel = amount / (Math.max(0.03, len) * this.sr);
    }
    panic() {
      for (let i = 0; i < this.all.length; i++) this.all[i].on = false;
      this.nVoices = 0;
      this.reverb.clear(); this.echo.clear(); this.chorus.clear();
      this.tL.reset(); this.tR.reset(); this.glue.reset(); this.master.reset();
      this.dEnv = 0; this.dRise = false;
      this.faults++;
    }

    /* ── commands from the host ── */
    handle(m) {
      if (m.delay > 0) {                                   // schedule on the audio clock
        this.later.push({ at: this.frame + m.delay * this.sr, m });
        m.delay = 0;
        return;
      }
      if (m.epoch !== undefined) this.epoch = m.epoch;
      switch (m.cmd) {
        case 'score':
          this.ev = m.events; this.count = m.count | 0; this.total = m.total;
          this.scenes = m.scenes && m.scenes.length >= SC.STRIDE ? m.scenes : null;
          this.sceneN = this.scenes ? Math.floor(this.scenes.length / SC.STRIDE) : 0;
          this.sceneAt = -1;
          this.passes = m.passes > 0 ? m.passes : Infinity;
          this.looping = m.loop !== false;
          this.bounds();
          this.ptr = this.lower(this.beat);
          this.seq++;
          break;
        case 'play':
          this.beat = (m.beat || 0) - (m.lead || 0) / this.spb;
          this.ptr = this.lower(this.beat);
          this.playing = true; this.sceneAt = -1; this.seq++;
          break;
        case 'stop':
          this.playing = false;
          this.fadeGroup(0, num(m.fade, 0.6));
          this.seq++;
          break;
        case 'seek':
          this.fadeGroup(0, 0.05);
          this.beat = m.beat; this.ptr = this.lower(m.beat); this.sceneAt = -1; this.seq++;
          break;
        case 'tempo':
          if (m.spb > 0) { this.spb = m.spb; this.bps = 1 / (m.spb * this.sr); this.seq++; }
          break;
        case 'region':
          this.region = m.end > m.start;
          this.rStart = m.start; this.rEnd = m.end;
          this.bounds(); this.seq++;
          break;
        case 'param': this.setParam(m.name, m.value, m.time, m.mode); break;
        case 'params': for (const p of m.list) this.setParam(p[0], p[1], p[2], p[3]); break;
        case 'tables':
          if (m.drop) for (const id of m.drop) if (id > 1) this.tables.delete(id);
          if (m.set) for (const t of m.set) this.setTable(t[0], t[1]);
          break;
        case 'reverb': this.reverb.set(num(m.rt60, 3.1), num(m.bright, 0.5), num(m.pre, 0.018), m.taps || null); break;
        case 'bus': {
          const b = BUS[m.name];
          if (b === undefined) break;
          if (m.rev !== undefined) this.bRev[b] = m.rev;
          if (m.del !== undefined) this.bDel[b] = m.del;
          if (m.cho !== undefined) this.bCho[b] = m.cho;
          if (m.dest !== undefined) this.bDest[b] = m.dest;
          if (m.sat !== undefined) this.bSat[b] = m.sat ? 1 : 0;
          break;
        }
        case 'note': this.spawn(m.e, 0, m._off | 0, 1, 1, m.id | 0); break;     // a free note: its duration is in seconds
        case 'off':
          for (let i = 0; i < this.all.length; i++) {
            const v = this.all[i];
            if (v.on && v.id === m.id) { v.id = 0; v.hold = Infinity; v.release(); }
          }
          break;
        case 'allOff': this.fadeGroup(1, 0.05); break;
        case 'config': if (m.maxVoices > 0) this.maxVoices = m.maxVoices; break;
        case 'panic': this.panic(); break;
      }
    }
    runLater(n) {
      const q = this.later, end = this.frame + n;
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].at < end) {
          const it = q[i];
          q[i] = q[q.length - 1]; q.pop();
          it.m._off = clamp(Math.floor(it.at - this.frame), 0, n - 1);
          this.handle(it.m);
        }
      }
    }

    /** What the host needs to draw in time with us. Call after process(). */
    state() {
      const m = {
        t: 'state', epoch: this.epoch, frame: this.frame, beat: this.beat, bps: this.playing ? this.bps : 0,
        ls: this.ls, le: this.le, loop: this.looping, voices: this.nVoices, peak: this.peak,
        faults: this.faults, stolen: this.stolen, meters: this.bPeak.slice(), load: 0,
      };
      this.peak = 0; this.bPeak.fill(0);
      return m;
    }

    /* ── the audio callback ── */
    process(outL, outR, n) {
      if (n > this.cap) this.alloc(n);
      if (this.later.length) this.runLater(n);
      if (this.playing) this.advance(n);
      if (this.sceneN) this.scene();
      this.tickParams(n);

      /* voices → buses */
      const all = this.all, buf = this.scratch, use = this.use, busL = this.busL, busR = this.busR;
      let active = 0;
      for (let vi = 0, vn = all.length; vi < vn; vi++) {
        const v = all[vi];
        if (!v.on) continue;
        active++;
        const from = v.offset;
        v.offset = 0;
        let end;
        if (v.hold <= n - from) {                          // the note ends inside this block: release on the exact sample
          const mid = from + v.hold;
          v.hold = Infinity;
          end = v.render(buf, from, mid);
          if (v.on) { v.release(); end = v.render(buf, mid, n); }
        } else {
          v.hold -= n - from;
          end = v.render(buf, from, n);
        }
        const b = v.bus, L = busL[b], R = busR[b];
        if (use[b] === 0) { use[b] = 1; L.fill(0, 0, n); R.fill(0, 0, n); }
        const gl = v.gl, gr = v.gr;
        if (v.fadeInc === 0) {
          for (let j = from; j < end; j++) { const x = buf[j]; L[j] += x * gl; R[j] += x * gr; }
        } else {
          let f = v.fade;
          const df = v.fadeInc;
          for (let j = from; j < end; j++) {
            const x = buf[j] * f;
            L[j] += x * gl; R[j] += x * gr;
            if ((f -= df) <= 0) { f = 0; v.on = false; break; }
          }
          v.fade = f;
        }
      }
      this.nVoices = active;

      const pv = this.pv;
      if (active === 0 && this.quiet > this.quietMax) {    // nothing sounding and the tails have died: cost nothing
        outL.fill(0, 0, n); outR.fill(0, 0, n);
        for (let b = 0; b < NB; b++) this.bGain[b] = pv[P_BUS + b];
        this.mPrev = pv[P_MASTER];
        this.frame += n;
        return;
      }

      /* buses → groups and sends */
      const musL = this.musL, musR = this.musR, drmL = this.drmL, drmR = this.drmR, pstL = this.pstL, pstR = this.pstR;
      const revL = this.revL, revR = this.revR, delL = this.delL, delR = this.delR, cho = this.cho;
      musL.fill(0, 0, n); musR.fill(0, 0, n); drmL.fill(0, 0, n); drmR.fill(0, 0, n); pstL.fill(0, 0, n); pstR.fill(0, 0, n);
      revL.fill(0, 0, n); revR.fill(0, 0, n); delL.fill(0, 0, n); delR.fill(0, 0, n); cho.fill(0, 0, n);
      for (let b = 0; b < NB; b++) {
        const g1 = pv[P_BUS + b], g0 = this.bGain[b];
        this.bGain[b] = g1;
        if (use[b] === 0) continue;
        use[b] = 0;
        const L = busL[b], R = busR[b], dest = this.bDest[b];
        const dL = dest === 1 ? drmL : dest === 2 ? pstL : musL, dR = dest === 1 ? drmR : dest === 2 ? pstR : musR;
        const rev = this.bRev[b], del = this.bDel[b], ch = this.bCho[b] * 0.5, sat = this.bSat[b] !== 0;
        const dg = (g1 - g0) / n;
        let g = g0, pk = 0;
        for (let i = 0; i < n; i++) {
          g += dg;
          let l = L[i] * g, r = R[i] * g;
          if (sat) {
            l *= 1.8; l = l > 3 ? 3 : l < -3 ? -3 : l; l = ((l * (27 + l * l)) / (27 + 9 * l * l)) * SAT_NORM;
            r *= 1.8; r = r > 3 ? 3 : r < -3 ? -3 : r; r = ((r * (27 + r * r)) / (27 + 9 * r * r)) * SAT_NORM;
          }
          dL[i] += l; dR[i] += r;
          revL[i] += l * rev; revR[i] += r * rev;
          delL[i] += l * del; delR[i] += r * del;
          cho[i] += (l + r) * ch;
          const a = l < 0 ? -l : l;
          if (a > pk) pk = a;
        }
        if (pk > this.bPeak[b]) this.bPeak[b] = pk;
      }

      /* effects on the music group */
      const cAmt = pv[P_CHORUS];
      if (cAmt > 0.001) this.chorus.run(cho, musL, musR, n, cAmt * MIX.chorus);
      this.echo.run(delL, delR, musL, musR, revL, revR, n, this.spb * 0.75, pv[P_ECHOFB], pv[P_ECHO]);
      this.reverb.run(revL, revR, musL, musR, n, pv[P_SPACE]);
      if (this.dRise || this.dEnv > 0) {
        const goal = this.dGoal, atk = this.dAtk, rel = this.dRel;
        let env = this.dEnv, rise = this.dRise;
        for (let i = 0; i < n; i++) {
          if (rise) { env += atk; if (env >= goal) { env = goal; rise = false; } }
          else if (env > 0) { env -= rel; if (env < 0) env = 0; }
          const g = 1 - env;
          musL[i] *= g; musR[i] *= g;
        }
        this.dEnv = env; this.dRise = rise;
      }
      const cm = pv[P_CMIX];
      if (cm > 0.001) this.crusher.run(musL, musR, n, cm, pv[P_CBITS], pv[P_CHOLD], pv[P_CFOLD], pv[P_CDRIVE]);
      this.glue.run(drmL, drmR, n);

      /* sum → tone filter → compressor → master → soft clip */
      const tone = pv[P_TONE], filt = tone < 18000, tL = this.tL, tR = this.tR;
      if (filt) { tL.set(tone, 0.5, this.sr); tR.set(tone, 0.5, this.sr); }
      for (let i = 0; i < n; i++) {
        let l = musL[i] + drmL[i], r = musR[i] + drmR[i];
        if (filt) { l = tL.lp(l); r = tR.lp(r); }
        outL[i] = l + pstL[i]; outR[i] = r + pstR[i];
      }
      this.master.run(outL, outR, n);
      const m1 = pv[P_MASTER], dm = (m1 - this.mPrev) / n;
      let mg = this.mPrev, pk = 0, chk = 0;
      this.mPrev = m1;
      for (let i = 0; i < n; i++) {
        mg += dm;
        let l = outL[i] * mg, r = outR[i] * mg;
        chk += l + r;
        let a = l < 0 ? -l : l;
        if (a > 0.9) { a = 0.9 + (0.1 * (a - 0.9)) / (a - 0.8); l = l < 0 ? -a : a; }
        let c = r < 0 ? -r : r;
        if (c > 0.9) { c = 0.9 + (0.1 * (c - 0.9)) / (c - 0.8); r = r < 0 ? -c : c; }
        if (c > a) a = c;
        if (a > pk) pk = a;
        outL[i] = l; outR[i] = r;
      }
      if (!(chk > -1e9 && chk < 1e9)) {                    // a NaN or runaway somewhere: clear state, stay alive
        this.panic();
        outL.fill(0, 0, n); outR.fill(0, 0, n);
        pk = 0;
      }
      if (pk > this.peak) this.peak = pk;
      this.quiet = pk < 1e-5 && active === 0 ? this.quiet + 1 : 0;
      this.frame += n;
    }
  }

  /* ── §K8 HOST HELPERS: writing events and plans ───────────────────────── */

  /** Write one event at arr[o…]. Missing or non-finite values take the instrument's defaults. */
  function writeEvent(arr, o, kind, ev) {
    const K = KINDS[typeof kind === 'number' ? kind : KIND[kind]];
    if (!K) throw new Error('unknown instrument: ' + kind);
    arr[o + EV.BEAT] = num(ev.beat, 0);
    arr[o + EV.KIND] = K.id;
    arr[o + EV.BUS] = typeof ev.bus === 'number' ? ev.bus : BUS[ev.bus] !== undefined ? BUS[ev.bus] : 0;
    arr[o + EV.FREQ] = clamp(num(ev.freq, 440), 8, 20000);
    arr[o + EV.FROM] = clamp(num(ev.from, 0), 0, 20000);
    arr[o + EV.DUR] = Math.max(0, num(ev.dur, 0));
    arr[o + EV.VEL] = Math.max(0, num(ev.vel, 0.8));
    arr[o + EV.PAN] = clamp(num(ev.pan, 0), -1, 1);
    arr[o + EV.TA] = num(ev.ta, 0);
    arr[o + EV.TB] = num(ev.tb, arr[o + EV.TA]);
    arr[o + EV.FLAGS] = 0;
    arr[o + EV.DUCK] = Math.max(0, num(ev.duck, 0));
    arr[o + EV.DUCKLEN] = num(ev.duckLen, 0.15);
    for (let i = 0; i < NP; i++) arr[o + EV.P + i] = i < K.names.length ? num(ev[K.names[i]], K.defaults[i]) : 0;
  }

  /** A growable list of events. add() in any order; finish() returns them sorted by beat. */
  class Plan {
    constructor(capacity) {
      this.cap = Math.max(16, capacity | 0 || 2048);
      this.data = new Float64Array(this.cap * EV.STRIDE);
      this.count = 0; this.sorted = true; this.last = -Infinity;
    }
    add(kind, ev) {
      if (this.count === this.cap) {
        const d = new Float64Array((this.cap *= 2) * EV.STRIDE);
        d.set(this.data);
        this.data = d;
      }
      const o = this.count++ * EV.STRIDE;
      writeEvent(this.data, o, kind, ev);
      if (this.data[o] < this.last) this.sorted = false;
      this.last = this.data[o];
      return this;
    }
    finish() {
      const S = EV.STRIDE, n = this.count;
      let out = this.data.slice(0, n * S);
      if (!this.sorted) {
        const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => out[a * S] - out[b * S] || a - b);
        const s = new Float64Array(n * S);
        for (let i = 0; i < n; i++) s.set(out.subarray(order[i] * S, order[i] * S + S), i * S);
        out = s;
      }
      return { events: out, count: n };
    }
  }

  /**
   * Offline rendering. job = { sr, frames, setup: [commands…] }.
   * Returns { step(maxFrames) → progress 0…1, L, R }. The caller decides how to slice the work.
   */
  function createRender(job) {
    const k = new Kernel(job.sr);
    for (const m of job.setup) k.handle(m);
    const total = job.frames | 0;
    const L = new Float32Array(total), R = new Float32Array(total);
    const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
    let pos = 0;
    return {
      L, R, kernel: k,
      step(maxFrames) {
        const end = Math.min(total, pos + Math.max(BLOCK, maxFrames | 0));
        while (pos < end) {
          const n = Math.min(BLOCK, end - pos);
          k.frame = pos;
          k.process(bl, br, n);
          if (n === BLOCK) { L.set(bl, pos); R.set(br, pos); }
          else { L.set(bl.subarray(0, n), pos); R.set(br.subarray(0, n), pos); }
          pos += n;
        }
        return total ? pos / total : 1;
      },
    };
  }

  /* ── §K9 BOOT: become a worklet processor or a render worker, if that is where we are ── */
  function boot() {
    if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
      const now = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();
      class SigilKernelProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          const k = (this.k = new Kernel(sampleRate));
          this.seq = -1; this.next = 0; this.busy = 0; this.frames = 0; this.spare = new Float32Array(BLOCK); this.failed = false;
          this.port.onmessage = (e) => {
            try { k.handle(e.data); }
            catch (err) { this.port.postMessage({ t: 'error', message: String((err && err.stack) || err) }); }
          };
          this.port.postMessage({ t: 'ready', sampleRate });
        }
        process(inputs, outputs) {
          const out = outputs[0];
          if (!out || !out.length) return true;
          const L = out[0], n = L.length, k = this.k;
          let R = out[1];
          if (!R) { if (this.spare.length < n) this.spare = new Float32Array(n); R = this.spare; }
          k.frame = currentFrame;
          const t0 = now();
          try { k.process(L, R, n); }
          catch (err) {
            L.fill(0); R.fill(0); k.panic();
            if (!this.failed) { this.failed = true; this.port.postMessage({ t: 'error', message: String((err && err.stack) || err) }); }
          }
          this.busy += now() - t0; this.frames += n;
          if (k.seq !== this.seq || currentFrame >= this.next) {
            const m = k.state();
            m.load = this.frames ? this.busy / 1000 / (this.frames / sampleRate) : 0;
            this.busy = 0; this.frames = 0; this.seq = k.seq; this.next = currentFrame + REPORT;
            this.port.postMessage(m);
          }
          return true;
        }
      }
      registerProcessor('sigil-kernel', SigilKernelProcessor);
      return 'worklet';
    }
    if (typeof importScripts === 'function' && typeof scope.postMessage === 'function') {
      scope.onmessage = (e) => {
        const job = e.data;
        if (!job || job.cmd !== 'render') return;
        try {
          const r = createRender(job);
          let p = 0, last = 0;
          while (p < 1) {
            p = r.step(job.sr * 2);
            if (p - last > 0.02 || p >= 1) { last = p; scope.postMessage({ progress: p }); }
          }
          scope.postMessage({ done: true, L: r.L, R: r.R }, [r.L.buffer, r.R.buffer]);
        } catch (err) { scope.postMessage({ error: String((err && err.stack) || err) }); }
      };
      return 'worker';
    }
    return 'page';
  }

  return {
    Kernel, Plan, writeEvent, buildTables, createRender, boot,
    EV, SC, BUS, BUS_DEF, KIND, KINDS, TIERS, TLEN, BLOCK, MIX,
    PARAMS: PARAM_DEF.map((p) => p[0]),
  };
}

const SigilKernel = SigilKernelFactory(globalThis);
SigilKernel.boot();   // a no-op on the page; registers the processor or the worker handler elsewhere