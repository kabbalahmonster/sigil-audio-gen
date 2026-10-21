/* ══════════════════════════════════════════════════════════════════════════
   SIGIL DSP CORE v4
   --------------------------------------------------------------------------
   Pure JavaScript synthesis. No Web Audio, no DOM, no imports. One file, three
   hosts, identical sound:
     • the page          classic <script>: wavetable building, constants
     • the AudioWorklet  imported by sigil-worklet.js: plays in real time
     • Web Workers/Node  importScripts / vm: renders offline, faster than RT

   REAL-TIME RULES (why this file looks the way it does)
     1. Nothing allocates inside process(). Voices, buffers and FX state are
        preallocated. Messages may allocate; they arrive BETWEEN blocks.
     2. No tan/exp/pow per sample. Coefficients are computed once per block.
     3. Events start sample-accurately inside the block.
     4. Each voice kind is one monomorphic init + render function pair, with
        state copied into locals for the inner loop.
     5. All randomness is an integer xorshift seeded from the event's SEED,
        which the compiler derives from musical identity. Render = performance.

   DATA FROM THE HOST (flat typed arrays, transferred, zero-copy)
     events    Float64Array, STRIDE per event, sorted by beat  → see EV
     sections  Float64Array, PSTRIDE per section               → see PA
     tables    Float32Array, CELL floats per cube cell (NT mip tiers)

   v3 adds the TOM voice and the drum FX chain (§5b). Both are inert until a
   plan asks for them: with every D* column at its default the drum path is
   sample-for-sample what v2 produced, which tests/drums.spec.mjs checks.

   v4 adds MOTION (§5c): automation lanes laid over the section patch. A lane is
   a baked curve on a sixteenth-note grid, so a value is a pure function of
   (beat, pass) and nothing else. That is the whole reason a live performance,
   a full render and a stem render move their knobs identically: all three ask
   the same table the same question. With no lanes, or with Motion and Evolve at
   rest, this file does exactly what v3 did.
   ══════════════════════════════════════════════════════════════════════════ */
   (function (G) {
    'use strict';
  
    /* ── §1 CONSTANTS ──────────────────────────────────────────────────────── */
    const VERSION = 4;
    const TAU = Math.PI * 2;
    const SQ2 = Math.SQRT2;
    const BLOCK = 128;                 // render quantum (Web Audio's, and ours offline)
    const TLEN = 1024, TLEN1 = TLEN + 1;
    const TIERS = [32, 16, 8, 4, 2];   // harmonics per mip tier: band-limiting by pitch
    const NT = TIERS.length;
    const CELL = NT * TLEN1;           // floats per cube cell, all tiers
    const H = 32, UPPER = 17;          // partials per cell; density tier starts at 17 (05b)
    const FX = 13, FY = 9, NCELL = FX * FY;
    const POOL = 104;                  // voice objects. The budget is a soft cap below this.
    const LIVE_MAX = 32;
    const NZ = 4.656612873077393e-10;  // 2^-31: int32 noise → [-1, 1)
    const REV_GAIN = 0.7, MAKEUP = 1.3; // tune by ear
  
    /** Voice kinds. LEAD is resolved at note-on by the patch's VOICE field. */
    const KIND = Object.freeze({ LEAD: 1, WAVE: 2, VOX: 3, FM: 4, BOW: 5, BELL: 6, PAD: 7,
      DRONE: 8, KICK: 9, SNARE: 10, HAT: 11, NOISE: 12, FIRE: 13, TOM: 14 });
  
    /** Buses. 'fx' = live keys and ritual sounds; 'post' bypasses the master chain and the banish filter. */
    const BUS_NAMES = Object.freeze(['lead', 'harm', 'bell', 'pad', 'bass', 'arp', 'drums', 'drone', 'fx', 'post']);
    const BUS = Object.freeze(Object.fromEntries(BUS_NAMES.map((b, i) => [b, i])));
    const NBUS = BUS_NAMES.length, B_DRUMS = BUS.drums, B_POST = BUS.post;
    //                    lead  harm  bell  pad   bass  arp   drums drone fx    post
    const BUS_DEFAULT = [0.9,  0.55, 0.8,  0.8,  0.85, 0.55, 0.85, 0.7,  0.8,  1];
    const SEND_REV    = [0.32, 0.45, 0.55, 0.5,  0.04, 0.35, 0.12, 0.45, 0.5,  0];
    const SEND_DLY    = [0.22, 0.1,  0.28, 0,    0,    0.42, 0,    0,    0.1,  0];
    const SEND_CHO    = [1,    0,    0,    1,    0,    0,    0,    0,    0,    0];
  
    /**
     * EVENT ROW (STRIDE = 16 numbers)
     *   BEAT  start (beats)      KIND   KIND.*         BUS   BUS.*
     *   F     Hz                 F0     glide-from Hz (melodic) | kind param (drums)
     *   DUR   beats (≤ 0 = held until noteOff)         VEL   velocity / peak
     *   PAN   −1…1               AUX    scale degree (melodic) | kind param
     *   P0…P5 kind-specific (see the init functions)   SEED  int32 noise seed
     */
    const EV = Object.freeze({ BEAT: 0, KIND: 1, BUS: 2, F: 3, F0: 4, DUR: 5, VEL: 6, PAN: 7,
      AUX: 8, P0: 9, P1: 10, P2: 11, P3: 12, P4: 13, P5: 14, SEED: 15 });
    const STRIDE = 16;
  
    /**
     * SECTION ROW (PSTRIDE = 40): the per-section sound patch, read at note-on and per block.
     * Columns 22+ are the drum FX chain (§5b). Their defaults are all "off", so a
     * host that never writes them gets the kit exactly as it was before the chain existed.
     *   DDRIVE 0…1 saturation                        DFILTER −1…1 (low-pass ↔ high-pass, 0 = open)
     *   DPUNCH −1…1 transient (soften ↔ sharpen)     DBODY  −1…1 tail (tighten ↔ lengthen)
     *   DCRUSH 0…1 crusher mix · DBITS 2…16 · DHOLD 1…16 (sample-hold)
     *   DSMASH 0…1 parallel compression              DROOM 0…1 room send · DSIZE 0…1 its decay
     *   DECHO  0…1 ping-pong echo send · DTIME its time in beats
     */
    const PA = Object.freeze({ START: 0, BRIGHT: 1, SUB: 2, BREATH: 3, THROAT: 4, WAVE: 5, LAYER: 6,
      SWEEP: 7, DRIFT: 8, VOWEL: 9, VOICE: 10, DRUMS: 11, HDECAY: 12, CHORUS: 13, ECHO: 14,
      GRIT: 15, BITS: 16, HOLD: 17, FOLD: 18, DRIVE: 19, DUCK: 20, INTENSITY: 21,
      DPUNCH: 22, DBODY: 23, DDRIVE: 24, DCRUSH: 25, DBITS: 26, DHOLD: 27, DFILTER: 28,
      DSMASH: 29, DROOM: 30, DSIZE: 31, DECHO: 32, DTIME: 33 });
    const PSTRIDE = 40;
    const DEFAULT_PATCH = new Float64Array(PSTRIDE);
    Object.entries({ BRIGHT: 0.6, SUB: 0.2, BREATH: 0.2, WAVE: 2, LAYER: 1, SWEEP: 0.5, DRIFT: 0.3,
      DRUMS: 1, HDECAY: 1, CHORUS: 0.3, ECHO: 0.3, BITS: 16, HOLD: 1, DUCK: 0.5, INTENSITY: 1,
      DBITS: 16, DHOLD: 1, DSIZE: 0.5, DTIME: 0.75 })
      .forEach(([k, v]) => { DEFAULT_PATCH[PA[k]] = v; });
  
    /**
     * AUTOMATION LANE (ASTRIDE numbers per lane), up to LANES of them. Written by 05d-motion.js.
     *   COL    the section column (PA.*) this lane moves     LO, HI  that column's limits
     *   DEPTH  how far it moves, in the column's own units   SEED    int, for this lane's per-pass wander
     *   GAIN   how much deeper it moves as passes go by      MORPH   how far it turns into its second curve
     *   SHIFT  how far its resting value drifts as the passes go by, in the column's own units (signed)
     *   LATENT 1 = asleep on the first pass; only Evolve wakes it
     *   GATE   1 = moves only what the patch already has on (a column resting at exactly 0 is left there)
     * Each lane has two curves (A then B), `len` points each, normalised to −1…1, one point per `step` beats.
     */
    const AU = Object.freeze({ COL: 0, LO: 1, HI: 2, DEPTH: 3, GAIN: 4, MORPH: 5, SHIFT: 6, LATENT: 7, SEED: 8, GATE: 9 });
    const ASTRIDE = 12, LANES = 8;

    /* Mirrors of SoundDesign tables, so the core has no dependencies. */
    const VOW_F = [[800, 1150, 2900, 3900], [530, 1840, 2480, 3500], [270, 2290, 3010, 3500],
                   [450, 800, 2830, 3800], [325, 700, 2530, 3500]];
    const VOW_G = [[1, 0.5, 0.25, 0.12], [1, 0.45, 0.22, 0.1], [1, 0.4, 0.3, 0.12],
                   [1, 0.6, 0.2, 0.1], [1, 0.5, 0.18, 0.08]];
    // consonant class: 0 liquid · 1 plosive · 2 fricative · 3 nasal
    const CONS_LVL = [0.05, 0.18, 0.13, 0.05];
    const CONS_TONE = [1.0, 0.85, 1.25, 0.7];
    const HAT_R = [1, 1.4471, 1.6317, 1.9323, 2.5465, 2.7];
    const HAT_METAL = [1, 1.3, 1.63, 1.95, 2.47, 3.0];
    const METAL = [1, 1.4, 1.67, 2.1, 2.74, 3.1];
    const DET_DN = Math.pow(2, -6 / 1200), DET_UP = Math.pow(2, 6 / 1200);
  
    /* ── §2 HELPERS ────────────────────────────────────────────────────────── */
    const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
    const ci = (x, n) => clamp(Math.round(x), 0, n - 1);
    /** Rational tanh: exact at 0 and ±3, no transcendental call. */
    const sat = (x) => (x <= -3 ? -1 : x >= 3 ? 1 : (x * (27 + x * x)) / (27 + 9 * x * x));
    /** One-pole smoothing coefficient for a time constant. */
    const coefOf = (sec, sr) => 1 - Math.exp(-1 / Math.max(1e-6, sec * sr));
    /** Per-sample multiplier for an exponential decay with time constant `sec`. */
    const decayOf = (sec, sr) => Math.exp(-1 / Math.max(1e-6, sec * sr));
    /** TPT state-variable filter coefficients into cf[j..j+3] = a1, a2, a3, k. */
    function svfSet(cf, j, sr, fc, q) {
      const g = Math.tan((Math.PI * clamp(fc, 10, sr * 0.45)) / sr), k = 1 / (q > 0.05 ? q : 0.05);
      const a1 = 1 / (1 + g * (g + k));
      cf[j] = a1; cf[j + 1] = g * a1; cf[j + 2] = g * g * a1; cf[j + 3] = k;
    }
  
    /* ── §2b MOTION: the two questions, asked identically by the core and by the page ─────────
       These are pure. The core calls them on the audio thread; the interface calls the SAME
       functions to draw a knob's bead, so what is seen is what is heard, by construction. */

    /** Uniform [0,1) from three integers. Stateless: a pass's wander does not depend on the passes before it. */
    function hash01(a, b, c) {
      let h = (a | 0) ^ Math.imul((b | 0) + 1, 0x9e3779b1) ^ Math.imul((c | 0) + 1, 0x85ebca6b);
      h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
      h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    }

    /**
     * How far along its evolution a pass is, 0…1: nothing on the first pass, more than half by the
     * second, all but settled by the fifth (0 · .58 · .82 · .93 · .97 …). After that only the wander moves.
     */
    const autoTrend = (pass) => (pass > 0 ? 1 - Math.pow(2, -pass / 0.8) : 0);

    /**
     * What a pass does to lane `j`: out[0] depth (column units, Motion applied), out[1] morph 0…1
     * between its two curves, out[2] the drift of its resting value (column units).
     * Pass 0 is the rite as written: no morph, no drift, latent lanes asleep. From there Evolve
     * leans each lane toward its own ends (a trend that settles after a few passes) and adds a
     * small bounded wander, so a rite left to loop keeps changing without ever running away.
     */
    function autoPass(lanes, j, pass, motion, evolve, out) {
      const o = j * ASTRIDE, p = pass > 0 ? pass : 0, E = clamp(+evolve || 0, 0, 1), M = motion > 0 ? +motion : 0;
      const seed = lanes[o + AU.SEED] | 0;
      const t = E * autoTrend(p);
      const w1 = p ? hash01(seed, p, 1) * 2 - 1 : 0, w2 = p ? hash01(seed, p, 2) * 2 - 1 : 0, w3 = p ? hash01(seed, p, 3) * 2 - 1 : 0;
      let dm = lanes[o + AU.LATENT] > 0 ? t * (0.75 + 0.25 * w1) : 1 + t * lanes[o + AU.GAIN] + t * 0.25 * w1;
      if (dm < 0) dm = 0;
      out[0] = lanes[o + AU.DEPTH] * M * dm;
      out[1] = clamp(t * lanes[o + AU.MORPH] + t * 0.3 * w2, 0, 1);
      out[2] = lanes[o + AU.SHIFT] * t * (1 + 0.4 * w3);
      return out;
    }

    /**
     * Lay a mover's offset over a column's resting value. At a limit the motion TURNS BACK instead
     * of going flat: a knob already near the top of its travel still moves all the time, downward.
     */
    function autoApply(base, off, lo, hi) {
      let v = base + off;
      if (v > hi) v = hi - (v - hi); else if (v < lo) v = lo + (lo - v);
      return v < lo ? lo : v > hi ? hi : v;
    }

    /** Lane `j`'s curve at `beat`, −1…1: its two baked curves, read between grid points and blended by `morph`. */
    function autoCurve(curves, len, step, j, beat, morph) {
      const x = beat / step;
      let k = x | 0;
      if (k < 0) k = 0; else if (k > len - 2) k = len - 2;
      let f = x - k;
      if (f < 0) f = 0; else if (f > 1) f = 1;
      const a0 = 2 * j * len + k, b0 = a0 + len;
      const a = curves[a0] + (curves[a0 + 1] - curves[a0]) * f;
      if (!(morph > 0)) return a;
      const b = curves[b0] + (curves[b0 + 1] - curves[b0]) * f;
      return a + (b - a) * morph;
    }

    const SIN = new Float32Array(TLEN1);
    for (let i = 0; i < TLEN1; i++) SIN[i] = Math.sin((TAU * i) / TLEN);
    /** sin(2π·p) for p in [0,1), by table. */
    function sinAt(p) { const x = p * TLEN, k = x | 0; return SIN[k] + (SIN[k + 1] - SIN[k]) * (x - k); }
    /** Read a wavetable tier (offset o) at phase p in [0,1). */
    function tabAt(t, o, p) { const x = p * TLEN, k = x | 0, i = o + k; return t[i] + (t[i + 1] - t[i]) * (x - k); }
  
    /* ── §3 WAVETABLES (built on the host, never on the audio thread) ──────── */
    /**
     * Additive synthesis into NT band-limited tiers, by integer sine-table lookup
     * (no trig). All tiers share tier 0's normalisation so loudness does not jump
     * between tiers. `out` must be zeroed in [at, at + CELL).
     */
    function buildTables(re, im, out, at) {
      out = out || new Float32Array(CELL);
      at = at | 0;
      const top = Math.min(H, re.length - 1, im.length - 1);
      let norm = 1;
      for (let k = 0; k < NT; k++) {
        const base = at + k * TLEN1, maxH = Math.min(TIERS[k], top);
        for (let h = 1; h <= maxH; h++) {
          const s = im[h], c = re[h];
          if (s === 0 && c === 0) continue;
          let p = 0;
          for (let i = 0; i < TLEN; i++) {
            out[base + i] += s * SIN[p] + c * SIN[(p + 256) & 1023];
            p = (p + h) & 1023;
          }
        }
        if (k === 0) {
          let mx = 0;
          for (let i = 0; i < TLEN; i++) { const a = Math.abs(out[base + i]); if (a > mx) mx = a; }
          norm = mx > 1e-6 ? 1 / mx : 1;
        }
        for (let i = 0; i < TLEN; i++) out[base + i] *= norm;
        out[base + TLEN] = out[base];
      }
      return out;
    }
    const SRE = new Float64Array(H + 1), SIM = new Float64Array(H + 1);
    /** One cube cell from packed spectra (Float32Array NCELL·2·(H+1)), shaped by tilt and density. */
    function buildCell(spectra, cell, tilt, density, out, at) {
      const H1 = H + 1, o = cell * 2 * H1;
      for (let h = 1; h <= H; h++) {
        const g = Math.pow(h, -tilt) * (h >= UPPER ? density : 1);
        SRE[h] = spectra[o + h] * g;
        SIM[h] = spectra[o + H1 + h] * g;
      }
      return buildTables(SRE, SIM, out, at);
    }
    function seriesTable(fn) {
      const re = new Float64Array(H + 1), im = new Float64Array(H + 1);
      for (let h = 1; h <= H; h++) im[h] = fn(h);
      return buildTables(re, im);
    }
  
    /* ── §4 VOICE ──────────────────────────────────────────────────────────── */
    class Voice {
      constructor() {
        this.active = false; this.kind = 0; this.bus = 0; this.id = 0; this.live = false; this.order = 0;
        this.off = 0; this.age = 0; this.t = 0; this.gate = 0;
        this.vel = 0; this.gl = 1; this.gr = 1; this.lvl = 1;
        this.f = 1; this.glide = 1; this.glideC = 0;
        this.tab = null; this.tab1 = null; this.o0 = 0; this.o1 = 0; this.xf = 0; this.xfInc = 0;
        this.env = 0; this.stage = 0; this.aInc = 0; this.dC = 0; this.sus = 0; this.rC = 0; this.peak = 0;
        this.kf = 1; this.kd = 1; this.rng = 1; this.sub = 0; this.n = 0; this.mode = 0;
        this.vibA = 0; this.vibPh = 0; this.vibInc = 0; this.vibR = 0; this.vibRI = 0;
        this.cut = 0; this.cutT = 0; this.cutC = 0;
        this.p = new Float64Array(24);   // kind-specific scalars
        this.ph = new Float64Array(12);  // oscillator phases
        this.inc = new Float64Array(12); // phase increments / ratios
        this.lv = new Float64Array(8);   // layer levels
        this.dk = new Float64Array(8);   // per-sample decay multipliers
        this.cf = new Float64Array(24);  // up to 6 SVF coefficient sets
        this.fs = new Float64Array(12);  // up to 6 SVF states
      }
      clear() {
        this.p.fill(0); this.ph.fill(0); this.inc.fill(0); this.lv.fill(0); this.dk.fill(0); this.fs.fill(0);
        this.kf = 1; this.kd = 1; this.glide = 1; this.xf = 0; this.xfInc = 0; this.vibA = 0; this.vibR = 0;
        this.sub = 0; this.tab1 = null; this.lvl = 1; this.t = 0; this.age = 0; this.n = 0; this.mode = 0;
        this.stage = 0; this.env = 0;
      }
    }
  
    /** Linear attack, exponential decay to sustain, exponential release (time constants). */
    function envStart(v, sr, a, dTc, s, rTc, peak) {
      v.peak = peak; v.sus = s * peak;
      v.aInc = peak / Math.max(1, a * sr);
      v.dC = coefOf(dTc, sr); v.rC = coefOf(rTc, sr);
      v.env = 0; v.stage = 1;
    }
  
    /** Fields every voice shares. Returns the remaining duration in seconds. */
    function common(c, v, src, o, el) {
      const sr = c.sr;
      v.bus = src[o + EV.BUS] | 0;
      if (v.bus < 0 || v.bus >= NBUS) v.bus = 0;
      v.f = src[o + EV.F] > 0 ? src[o + EV.F] : 1;
      const f0 = src[o + EV.F0];
      v.glide = f0 > 0 && el === 0 ? f0 / v.f : 1;
      v.glideC = coefOf(0.025, sr);
      v.vel = src[o + EV.VEL];
      const pan = clamp(src[o + EV.PAN], -1, 1), a = ((pan + 1) * Math.PI) / 4;
      v.gl = Math.min(1, Math.cos(a) * SQ2); v.gr = Math.min(1, Math.sin(a) * SQ2);   // centre = unity
      v.rng = (src[o + EV.SEED] | 0) || 0x2545f491;
      const held = !(src[o + EV.DUR] > 0);
      const dur = held ? 3 : Math.max(0.02, (src[o + EV.DUR] - el) * c.spb());
      v.gate = held ? -1 : Math.max(1, Math.round(dur * sr));
      return dur;
    }
  
    /* LEAD resolves by the patch: 0 auto (glass→wave, reed→vox, koto→bell),
       1 wave, 2 vox, 3 fm, 4 bow, 5 bell.
       Row: P0 timbre · P1 vowel-memory index | −1 · P2 consonant class · P3 gain */
    function initLead(c, v, src, o, pb, el) {
      const timbre = src[o + EV.P0] | 0;
      let voice = c.sec[pb + PA.VOICE] | 0;
      if (voice === 0) voice = timbre === 1 ? 2 : timbre === 2 ? 5 : 1;
      const g = src[o + EV.P3] || 1;
      switch (voice) {
        case 2: return initVox(c, v, src, o, pb, el, g);
        case 3: return initFm(c, v, src, o, pb, el, g);
        case 4: return initBow(c, v, src, o, pb, el, g);
        case 5: return initBell(c, v, src, o, pb, el, g);
        default: return initWave(c, v, src, o, pb, el, -1, 0, 0.32 * g, true, true);
      }
    }
  
    /* ── WAVE: cube travel (cell0 → cell1 across the note), LP, sub, vibrato ──
       Row: P0 bright (−1 = patch) · P1 sub floor (−1 = none) · P2 peak · P3 travel(1) · P4 vibrato(1) */
    function initWave(c, v, src, o, pb, el, bright, subFloor, peak, travel, vib) {
      const sr = c.sr, S = c.sec, dur = common(c, v, src, o, el);
      v.kind = KIND.WAVE;
      if (bright < 0) bright = S[pb + PA.BRIGHT];
      v.sub = subFloor < 0 ? 0 : Math.max(S[pb + PA.SUB], subFloor) * 0.55;
      c.pickCells(pb, src[o + EV.AUX], travel);
      v.tab = c.c0; v.tab1 = c.c1;
      v.o0 = v.o1 = c.tier(v.f * Math.max(1, v.glide) * 1.02);
      v.xfInc = travel && v.tab1 !== v.tab ? 1 / Math.max(1, dur * sr) : 0;
      const c0 = v.f * (1.5 + 9 * bright);
      v.cut = c0; v.cutT = c0 * 0.4;
      v.cutC = 1 - Math.exp(-BLOCK / (Math.max(0.05, 0.3 * dur) * sr));
      if (vib && v.gate > 0 && dur > 0.45) {
        v.vibA = 0.004; v.vibInc = 5.4 / sr; v.vibRI = 1 / (Math.min(0.6, dur * 0.6) * sr);
      }
      envStart(v, sr, 0.012, 0.083, 0.78, 0.073, v.vel * peak);
    }
    function rWave(c, v, L, R, from, n) {
      const sr = c.sr, t0 = v.tab, t1 = v.tab1 || v.tab, o0 = v.o0, o1 = v.o1;
      v.cut += v.cutC * (v.cutT - v.cut);
      svfSet(v.cf, 0, sr, v.cut, 0.7);
      const a1 = v.cf[0], a2 = v.cf[1], a3 = v.cf[2];
      const fs = v.f / sr, glC = v.glideC, xfI = v.xfInc, sub = v.sub, vA = v.vibA, vI = v.vibInc, vRI = v.vibRI;
      const aI = v.aInc, dC = v.dC, su = v.sus, rC = v.rC, pk = v.peak, kd = v.kd;
      const gL = v.gl * v.lvl, gR = v.gr * v.lvl;
      let s1 = v.fs[0], s2 = v.fs[1], ph = v.ph[0], phs = v.ph[1], gl = v.glide, xf = v.xf, vp = v.vibPh, vr = v.vibR;
      let e = v.env, st = v.stage, gate = v.gate, kf = v.kf, i = from;
      for (; i < n; i++) {
        if (gl !== 1) { gl += (1 - gl) * glC; if (gl > 0.99995 && gl < 1.00005) gl = 1; }
        let m = gl;
        if (vA !== 0) { vp += vI; if (vp >= 1) vp -= 1; if (vr < 1) vr += vRI; m *= 1 + vA * vr * sinAt(vp); }
        const inc = fs * m;
        ph += inc; if (ph >= 1) ph -= 1;
        let y = tabAt(t0, o0, ph);
        if (xfI !== 0) { y += (tabAt(t1, o1, ph) - y) * xf; if (xf < 1) xf += xfI; }
        const v3 = y - s2, v1 = a1 * s1 + a2 * v3, v2 = s2 + a2 * s1 + a3 * v3;
        s1 = 2 * v1 - s1; s2 = 2 * v2 - s2; y = v2;
        if (sub !== 0) { phs += inc * 0.5; if (phs >= 1) phs -= 1; y += sinAt(phs) * sub; }
        if (st === 1) { e += aI; if (e >= pk) { e = pk; st = 2; } }
        else if (st === 2) e += dC * (su - e);
        else { e -= rC * e; if (e < 1e-5) { st = 0; break; } }
        if (gate > 0 && --gate === 0) st = 3;
        const out = y * e * kf; kf *= kd;
        L[i] += out * gL; R[i] += out * gR;
      }
      v.fs[0] = s1; v.fs[1] = s2; v.ph[0] = ph; v.ph[1] = phs; v.glide = gl; v.xf = xf; v.vibPh = vp; v.vibR = vr;
      v.env = e; v.stage = st; v.gate = gate; v.kf = kf; v.age += i - from;
      if (st === 0 || kf < 1e-3) v.active = false;
    }
  
    /* ── VOX: glottal pulse → 4 formants (morphing), consonant burst, breath ──
       Row: P1 vowel-memory index | −1 · P2 consonant class · P3 gain */
    function initVox(c, v, src, o, pb, el, g) {
      const sr = c.sr, S = c.sec, dur = common(c, v, src, o, el), P = v.p;
      v.kind = KIND.VOX;
      const bright = S[pb + PA.BRIGHT], breath = S[pb + PA.BREATH], tk = Math.pow(2, S[pb + PA.THROAT] * 0.35);
      const cls = clamp(src[o + EV.P2] | 0, 0, 3), deg = Math.round(src[o + EV.AUX]);
      let i0 = src[o + EV.P1];
      i0 = i0 >= 0 ? (i0 | 0) % 5 : (((deg + Math.round(S[pb + PA.VOWEL])) % 5) + 5) % 5;
      const i1 = dur > 0.6 ? (i0 + 1) % 5 : i0;
      v.tab = c.glottal;
      if (cls === 0) v.glide = 0.82;                        // a liquid slides into pitch
      v.glideC = coefOf(0.03, sr);
      v.o0 = c.tier(v.f * Math.max(1, v.glide) * 1.02);
      P[0] = 6 + 7 * bright; P[1] = 0.7 + 0.4 * bright;
      const open = cls === 3 ? 0.75 : 1;                    // a nasal opens into the vowel
      for (let j = 0; j < 4; j++) {
        P[2 + j] = VOW_F[i0][j] * tk * open; P[6 + j] = VOW_F[i1][j] * tk;
        P[10 + j] = VOW_G[i0][j] * (cls === 3 && j > 1 ? 0.5 : 1);
        svfSet(v.cf, j * 4, sr, P[2 + j], P[0]);
      }
      v.xf = 0; v.xfInc = 1 / Math.max(1, Math.min(dur * 0.9, 0.7) * sr);
      const clen = cls === 2 ? 0.09 : 0.022;
      P[14] = v.vel * CONS_LVL[cls] * (0.5 + breath);
      P[15] = decayOf(clen, sr); P[16] = Math.round(clen * 5 * sr);
      P[17] = breath * 0.06 * v.vel;
      P[18] = cls === 1 ? v.vel * 0.12 : 0; P[19] = decayOf(0.018, sr);
      P[20] = cls === 1 ? 1 : 0;
      svfSet(v.cf, 16, sr, 3200 * tk, 0.9);
      svfSet(v.cf, 20, sr, (cls === 1 ? 1800 : 3600) * CONS_TONE[cls], cls === 1 ? 1.4 : 0.7);
      v.sub = S[pb + PA.SUB] * 0.22;
      if (v.gate > 0) { v.vibA = 0.006; v.vibInc = 5.4 / sr; v.vibRI = 1 / (Math.min(0.6, dur * 0.6) * sr); }
      envStart(v, sr, 0.012, 0.083, 0.78, 0.073, v.vel * 0.42 * g);
    }
    function rVox(c, v, L, R, from, n) {
      const sr = c.sr, P = v.p, cf = v.cf, fs = v.fs;
      if (v.xf < 1) {
        v.xf += v.xfInc * (n - from); if (v.xf > 1) v.xf = 1;
        const w = v.xf;
        for (let j = 0; j < 4; j++) svfSet(cf, j * 4, sr, P[2 + j] + (P[6 + j] - P[2 + j]) * w, P[0]);
      }
      const t = v.tab, o0 = v.o0;
      const A0 = cf[0], B0 = cf[1], C0 = cf[2], G0 = cf[3] * P[10];
      const A1 = cf[4], B1 = cf[5], C1 = cf[6], G1 = cf[7] * P[11];
      const A2 = cf[8], B2 = cf[9], C2 = cf[10], G2 = cf[11] * P[12];
      const A3 = cf[12], B3 = cf[13], C3 = cf[14], G3 = cf[15] * P[13];
      const BA = cf[16], BB = cf[17], BC = cf[18], BK = cf[19];
      const NA = cf[20], NB = cf[21], NC = cf[22], NK = cf[23];
      const cD = P[15], bLv = P[17], tD = P[19], sumG = P[1], plos = P[20] === 1, sub = v.sub;
      const fsr = v.f / sr, glC = v.glideC, vA = v.vibA, vI = v.vibInc, vRI = v.vibRI;
      const aI = v.aInc, dC = v.dC, su = v.sus, rC = v.rC, pk = v.peak, kd = v.kd;
      const gL = v.gl * v.lvl, gR = v.gr * v.lvl;
      let a0 = fs[0], b0 = fs[1], a1 = fs[2], b1 = fs[3], a2 = fs[4], b2 = fs[5], a3 = fs[6], b3 = fs[7];
      let ba = fs[8], bb = fs[9], na = fs[10], nb = fs[11];
      let ph = v.ph[0], phs = v.ph[1], gl = v.glide, vp = v.vibPh, vr = v.vibR, r = v.rng | 0;
      let cLv = P[14], cl = P[16], tLv = P[18];
      let e = v.env, st = v.stage, gate = v.gate, kf = v.kf, i = from;
      for (; i < n; i++) {
        if (gl !== 1) { gl += (1 - gl) * glC; if (gl > 0.99995 && gl < 1.00005) gl = 1; }
        let m = gl;
        if (vA !== 0) { vp += vI; if (vp >= 1) vp -= 1; if (vr < 1) vr += vRI; m *= 1 + vA * vr * sinAt(vp); }
        const inc = fsr * m;
        ph += inc; if (ph >= 1) ph -= 1;
        const x = tabAt(t, o0, ph);
        let v3, v1, v2, y = 0;
        v3 = x - b0; v1 = A0 * a0 + B0 * v3; v2 = b0 + B0 * a0 + C0 * v3; a0 = 2 * v1 - a0; b0 = 2 * v2 - b0; y += v1 * G0;
        v3 = x - b1; v1 = A1 * a1 + B1 * v3; v2 = b1 + B1 * a1 + C1 * v3; a1 = 2 * v1 - a1; b1 = 2 * v2 - b1; y += v1 * G1;
        v3 = x - b2; v1 = A2 * a2 + B2 * v3; v2 = b2 + B2 * a2 + C2 * v3; a2 = 2 * v1 - a2; b2 = 2 * v2 - b2; y += v1 * G2;
        v3 = x - b3; v1 = A3 * a3 + B3 * v3; v2 = b3 + B3 * a3 + C3 * v3; a3 = 2 * v1 - a3; b3 = 2 * v2 - b3; y += v1 * G3;
        y *= sumG;
        r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
        const nz = r * NZ;
        if (cl > 0) {
          cl--;
          v3 = nz - nb; v1 = NA * na + NB * v3; v2 = nb + NB * na + NC * v3; na = 2 * v1 - na; nb = 2 * v2 - nb;
          y += (plos ? v1 * NK : nz - NK * v1 - v2) * cLv; cLv *= cD;
        }
        if (bLv !== 0) {
          v3 = nz - bb; v1 = BA * ba + BB * v3; v2 = bb + BB * ba + BC * v3; ba = 2 * v1 - ba; bb = 2 * v2 - bb;
          y += v1 * BK * bLv;
        }
        if (sub !== 0 || tLv > 1e-5) {
          phs += inc * 0.5; if (phs >= 1) phs -= 1;
          y += sinAt(phs) * (sub + tLv); tLv *= tD;
        }
        if (st === 1) { e += aI; if (e >= pk) { e = pk; st = 2; } }
        else if (st === 2) e += dC * (su - e);
        else { e -= rC * e; if (e < 1e-5) { st = 0; break; } }
        if (gate > 0 && --gate === 0) st = 3;
        const out = y * e * kf; kf *= kd;
        L[i] += out * gL; R[i] += out * gR;
      }
      fs[0] = a0; fs[1] = b0; fs[2] = a1; fs[3] = b1; fs[4] = a2; fs[5] = b2; fs[6] = a3; fs[7] = b3;
      fs[8] = ba; fs[9] = bb; fs[10] = na; fs[11] = nb;
      P[14] = cLv; P[16] = cl; P[18] = tLv;
      v.ph[0] = ph; v.ph[1] = phs; v.glide = gl; v.vibPh = vp; v.vibR = vr; v.rng = r;
      v.env = e; v.stage = st; v.gate = gate; v.kf = kf; v.age += i - from;
      if (st === 0 || kf < 1e-3) v.active = false;
    }
  
    /* ── FM: cube cell as carrier, sine modulator at a patch-derived ratio ──── */
    function initFm(c, v, src, o, pb, el, g) {
      const sr = c.sr, S = c.sec, dur = common(c, v, src, o, el), P = v.p;
      v.kind = KIND.FM;
      const bright = S[pb + PA.BRIGHT];
      c.pickCells(pb, 0, false); v.tab = c.c0;
      P[0] = v.f * (0.6 + 3.4 * bright) * v.vel;                 // index (Hz of deviation)
      P[1] = P[0] * 0.08;
      P[2] = decayOf(0.06 + 0.3 * dur, sr);
      P[3] = 1 + (Math.round(S[pb + PA.WAVE]) % 5) + (Math.round(S[pb + PA.LAYER]) % 2) * 0.5;
      v.o0 = c.tier((v.f + P[0]) * Math.max(1, v.glide));
      svfSet(v.cf, 0, sr, Math.min(16000, v.f * (6 + 12 * bright)), 0.6);
      v.sub = S[pb + PA.SUB] * 0.4;
      envStart(v, sr, 0.012, 0.083, 0.78, 0.073, v.vel * 0.3 * g);
    }
    function rFm(c, v, L, R, from, n) {
      const sr = c.sr, P = v.p, t = v.tab, o0 = v.o0;
      const a1 = v.cf[0], a2 = v.cf[1], a3 = v.cf[2];
      const idxT = P[1], idxD = P[2], mInc = (v.f * P[3]) / sr, glC = v.glideC, f = v.f, inv = 1 / sr, sub = v.sub;
      const aI = v.aInc, dC = v.dC, su = v.sus, rC = v.rC, pk = v.peak, kd = v.kd;
      const gL = v.gl * v.lvl, gR = v.gr * v.lvl;
      let s1 = v.fs[0], s2 = v.fs[1], ph = v.ph[0], phs = v.ph[1], mph = v.ph[2], gl = v.glide, idx = P[0];
      let e = v.env, st = v.stage, gate = v.gate, kf = v.kf, i = from;
      for (; i < n; i++) {
        if (gl !== 1) { gl += (1 - gl) * glC; if (gl > 0.99995 && gl < 1.00005) gl = 1; }
        mph += mInc; if (mph >= 1) mph -= 1;
        idx = idxT + (idx - idxT) * idxD;
        ph += (f * gl + idx * sinAt(mph)) * inv; ph -= Math.floor(ph);
        let y = tabAt(t, o0, ph);
        const v3 = y - s2, v1 = a1 * s1 + a2 * v3, v2 = s2 + a2 * s1 + a3 * v3;
        s1 = 2 * v1 - s1; s2 = 2 * v2 - s2; y = v2;
        if (sub !== 0) { phs += f * gl * inv * 0.5; if (phs >= 1) phs -= 1; y += sinAt(phs) * sub; }
        if (st === 1) { e += aI; if (e >= pk) { e = pk; st = 2; } }
        else if (st === 2) e += dC * (su - e);
        else { e -= rC * e; if (e < 1e-5) { st = 0; break; } }
        if (gate > 0 && --gate === 0) st = 3;
        const out = y * e * kf; kf *= kd;
        L[i] += out * gL; R[i] += out * gR;
      }
      v.fs[0] = s1; v.fs[1] = s2; v.ph[0] = ph; v.ph[1] = phs; v.ph[2] = mph; v.glide = gl; P[0] = idx;
      v.env = e; v.stage = st; v.gate = gate; v.kf = kf; v.age += i - from;
      if (st === 0 || kf < 1e-3) v.active = false;
    }
  
    /* ── BOW: detuned pair, opening filter with a noise "bow pressure" wobble ── */
    function initBow(c, v, src, o, pb, el, g) {
      const sr = c.sr, S = c.sec, dur = common(c, v, src, o, el), P = v.p;
      v.kind = KIND.BOW;
      c.pickCells(pb, 0, false); v.tab = c.c0;
      v.o0 = c.tier(v.f * Math.max(1, v.glide) * 1.01);
      v.glideC = coefOf(0.04, sr);
      v.inc[0] = Math.pow(2, -7 / 1200); v.inc[1] = Math.pow(2, 7 / 1200);
      P[0] = v.f * (2.5 + 8 * S[pb + PA.BRIGHT]);
      P[1] = Math.max(0.02, Math.min(0.5, dur * 0.5));
      P[2] = P[0] * 0.25 * (0.3 + S[pb + PA.BREATH]);
      v.ph[1] = 0.31;
      envStart(v, sr, 0.12, 0.1, 0.9, 0.117, v.vel * 0.3 * g);
    }
    function rBow(c, v, L, R, from, n) {
      const sr = c.sr, P = v.p, t = v.tab, o0 = v.o0;
      let r = v.rng | 0;
      r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
      P[3] += 0.15 * (r * NZ - P[3]);
      const ramp = v.t < P[1] ? v.t / P[1] : 1;
      svfSet(v.cf, 0, sr, P[0] * (0.5 + 0.5 * ramp) + P[3] * P[2], 1.6);
      v.t += (n - from) / sr;
      const a1 = v.cf[0], a2 = v.cf[1], a3 = v.cf[2], fs = v.f / sr, dn = v.inc[0], up = v.inc[1], glC = v.glideC;
      const aI = v.aInc, dC = v.dC, su = v.sus, rC = v.rC, pk = v.peak, kd = v.kd;
      const gL = v.gl * v.lvl, gR = v.gr * v.lvl;
      let s1 = v.fs[0], s2 = v.fs[1], p0 = v.ph[0], p1 = v.ph[1], gl = v.glide;
      let e = v.env, st = v.stage, gate = v.gate, kf = v.kf, i = from;
      for (; i < n; i++) {
        if (gl !== 1) { gl += (1 - gl) * glC; if (gl > 0.99995 && gl < 1.00005) gl = 1; }
        const inc = fs * gl;
        p0 += inc * dn; if (p0 >= 1) p0 -= 1;
        p1 += inc * up; if (p1 >= 1) p1 -= 1;
        const x = (tabAt(t, o0, p0) + tabAt(t, o0, p1)) * 0.5;
        const v3 = x - s2, v1 = a1 * s1 + a2 * v3, v2 = s2 + a2 * s1 + a3 * v3;
        s1 = 2 * v1 - s1; s2 = 2 * v2 - s2;
        if (st === 1) { e += aI; if (e >= pk) { e = pk; st = 2; } }
        else if (st === 2) e += dC * (su - e);
        else { e -= rC * e; if (e < 1e-5) { st = 0; break; } }
        if (gate > 0 && --gate === 0) st = 3;
        const out = v2 * e * kf; kf *= kd;
        L[i] += out * gL; R[i] += out * gR;
      }
      v.fs[0] = s1; v.fs[1] = s2; v.ph[0] = p0; v.ph[1] = p1; v.glide = gl; v.rng = r;
      v.env = e; v.stage = st; v.gate = gate; v.kf = kf; v.age += i - from;
      if (st === 0 || kf < 1e-3) v.active = false;
    }
  
    /* ── BELL: the cube cell struck, plus 2.76× and 3.01× partials and a sub ── */
    function initBell(c, v, src, o, pb, el, g) {
      const sr = c.sr, S = c.sec, dur = common(c, v, src, o, el), P = v.p;
      v.kind = KIND.BELL; v.stage = 3; v.gate = -1;
      const bright = S[pb + PA.BRIGHT];
      c.pickCells(pb, 0, false); v.tab = c.c0; v.o0 = c.tier(v.f);
      const ring = Math.max(dur * 1.6, 1.1) * (0.6 + 0.8 * S[pb + PA.HDECAY]);
      const f = v.f / sr;
      v.inc[0] = f; v.inc[1] = f * 2.76; v.inc[2] = f * 3.01; v.inc[3] = f * 0.5;
      v.lv[0] = 0.5; v.lv[1] = 0.22 * (0.4 + bright); v.lv[2] = 0.1 * (0.3 + bright); v.lv[3] = S[pb + PA.SUB] * 0.3;
      v.dk[0] = decayOf(ring * 0.45, sr); v.dk[1] = decayOf(ring * 0.3, sr);
      v.dk[2] = decayOf(ring * 0.18, sr); v.dk[3] = decayOf(ring * 0.6, sr);
      P[0] = 0; P[1] = 1 / Math.max(1, 0.004 * sr);
      v.peak = v.vel * 0.55 * g;
    }
    function rBell(c, v, L, R, from, n) {
      const t = v.tab, o0 = v.o0, P = v.p, lv = v.lv, dk = v.dk, inc = v.inc, ph = v.ph;
      const i0 = inc[0], i1 = inc[1], i2 = inc[2], i3 = inc[3], d0 = dk[0], d1 = dk[1], d2 = dk[2], d3 = dk[3];
      const gL = v.gl * v.lvl * v.peak, gR = v.gr * v.lvl * v.peak, aI = P[1], kd = v.kd;
      let p0 = ph[0], p1 = ph[1], p2 = ph[2], p3 = ph[3], l0 = lv[0], l1 = lv[1], l2 = lv[2], l3 = lv[3];
      let at = P[0], kf = v.kf;
      for (let i = from; i < n; i++) {
        if (at < 1) { at += aI; if (at > 1) at = 1; }
        p0 += i0; if (p0 >= 1) p0 -= 1; p1 += i1; if (p1 >= 1) p1 -= 1;
        p2 += i2; if (p2 >= 1) p2 -= 1; p3 += i3; if (p3 >= 1) p3 -= 1;
        const y = (tabAt(t, o0, p0) * l0 + sinAt(p1) * l1 + sinAt(p2) * l2 + sinAt(p3) * l3) * at * kf;
        l0 *= d0; l1 *= d1; l2 *= d2; l3 *= d3; kf *= kd;
        L[i] += y * gL; R[i] += y * gR;
      }
      ph[0] = p0; ph[1] = p1; ph[2] = p2; ph[3] = p3; lv[0] = l0; lv[1] = l1; lv[2] = l2; lv[3] = l3;
      P[0] = at; v.kf = kf; v.age += n - from;
      if ((l0 < 1e-4 && l1 < 1e-4 && l2 < 1e-4 && l3 < 1e-4) || kf < 1e-3) v.active = false;
    }
  
    /* ── PAD: a whole chord in ONE voice (≤5 notes × 2 detuned, stereo pair of LPs)
       Row: F + P0…P3 = note frequencies (0 = none) · P5 = intensity (0–3) */
    function initPad(c, v, src, o, pb, el) {
      const sr = c.sr, S = c.sec, dur = common(c, v, src, o, el), P = v.p;
      v.kind = KIND.PAD;
      c.pickCells(pb, 0, false); v.tab = c.c0;
      let k = 0, fmax = 0;
      const seed = v.rng >>> 0;
      for (let j = 0; j < 5; j++) {
        const f = j === 0 ? src[o + EV.F] : src[o + EV.P0 + j - 1];
        if (!(f > 0)) continue;
        v.inc[k] = (f * DET_DN) / sr; v.ph[k] = ((seed >>> (j * 3)) & 1023) / 1024; k++;
        v.inc[k] = (f * DET_UP) / sr; v.ph[k] = ((seed >>> (j * 3 + 11)) & 1023) / 1024; k++;
        if (f > fmax) fmax = f;
      }
      v.n = k;
      v.o0 = c.tier(fmax * 1.01);
      P[0] = (480 + 420 * src[o + EV.P5]) * (0.5 + S[pb + PA.BRIGHT]);
      P[1] = Math.max(0.05, dur * 0.5);
      const ts = c.ts();
      envStart(v, sr, 1.1 * ts, ts / 3, 0.85, 0.6 * ts, (v.vel * 0.14) / Math.sqrt(Math.max(1, k / 2)));
    }
    function rPad(c, v, L, R, from, n) {
      const sr = c.sr, P = v.p, t = v.tab, o0 = v.o0, ph = v.ph, inc = v.inc, N = v.n;
      const tt = v.t, ramp = tt < P[1] ? tt / P[1] : 1;
      svfSet(v.cf, 0, sr, P[0] * (0.6 + 0.4 * ramp) + 160 * Math.sin(TAU * 0.11 * tt), 0.7);
      v.t += (n - from) / sr;
      const a1 = v.cf[0], a2 = v.cf[1], a3 = v.cf[2];
      const aI = v.aInc, dC = v.dC, su = v.sus, rC = v.rC, pk = v.peak, kd = v.kd;
      const gL = v.gl * v.lvl, gR = v.gr * v.lvl;
      let l1 = v.fs[0], l2 = v.fs[1], r1 = v.fs[2], r2 = v.fs[3];
      let e = v.env, st = v.stage, gate = v.gate, kf = v.kf, i = from;
      for (; i < n; i++) {
        let xl = 0, xr = 0;
        for (let j = 0; j < N; j += 2) {
          let p = ph[j] + inc[j]; if (p >= 1) p -= 1; ph[j] = p; xl += tabAt(t, o0, p);
          p = ph[j + 1] + inc[j + 1]; if (p >= 1) p -= 1; ph[j + 1] = p; xr += tabAt(t, o0, p);
        }
        let v3 = xl - l2, v1 = a1 * l1 + a2 * v3, v2 = l2 + a2 * l1 + a3 * v3;
        l1 = 2 * v1 - l1; l2 = 2 * v2 - l2; const yl = v2;
        v3 = xr - r2; v1 = a1 * r1 + a2 * v3; v2 = r2 + a2 * r1 + a3 * v3;
        r1 = 2 * v1 - r1; r2 = 2 * v2 - r2; const yr = v2;
        if (st === 1) { e += aI; if (e >= pk) { e = pk; st = 2; } }
        else if (st === 2) e += dC * (su - e);
        else { e -= rC * e; if (e < 1e-5) { st = 0; break; } }
        if (gate > 0 && --gate === 0) st = 3;
        const k = e * kf; kf *= kd;
        L[i] += yl * k * gL; R[i] += yr * k * gR;
      }
      v.fs[0] = l1; v.fs[1] = l2; v.fs[2] = r1; v.fs[3] = r2;
      v.env = e; v.stage = st; v.gate = gate; v.kf = kf; v.age += i - from;
      if (st === 0 || kf < 1e-3) v.active = false;
    }
  
    /* ── DRONE: root + fifth (cube) + sub-octave, breathing LP ─────────────── */
    function initDrone(c, v, src, o, pb, el) {
      const sr = c.sr, dur = common(c, v, src, o, el);
      v.kind = KIND.DRONE; v.glide = 1;
      c.pickCells(pb, 0, false); v.tab = c.c0;
      v.o0 = c.tier(v.f * 1.52);
      v.inc[0] = v.f / sr; v.inc[1] = (v.f * 1.4983 * Math.pow(2, 4 / 1200)) / sr; v.inc[2] = (v.f * 0.5) / sr;
      v.gate = Math.max(1, Math.round(Math.max(0.05, dur - 1) * sr));
      envStart(v, sr, Math.max(0.05, Math.min(4, dur / 3)), 0.1, 1, 1.3, v.vel * 0.11);
    }
    function rDrone(c, v, L, R, from, n) {
      const sr = c.sr, t = v.tab, o0 = v.o0, inc = v.inc;
      svfSet(v.cf, 0, sr, 320 + 140 * Math.sin(TAU * 0.06 * v.t), 3);
      v.t += (n - from) / sr;
      const a1 = v.cf[0], a2 = v.cf[1], a3 = v.cf[2], i0 = inc[0], i1 = inc[1], i2 = inc[2];
      const aI = v.aInc, dC = v.dC, su = v.sus, rC = v.rC, pk = v.peak, kd = v.kd;
      const gL = v.gl * v.lvl, gR = v.gr * v.lvl;
      let s1 = v.fs[0], s2 = v.fs[1], p0 = v.ph[0], p1 = v.ph[1], p2 = v.ph[2];
      let e = v.env, st = v.stage, gate = v.gate, kf = v.kf, i = from;
      for (; i < n; i++) {
        p0 += i0; if (p0 >= 1) p0 -= 1; p1 += i1; if (p1 >= 1) p1 -= 1; p2 += i2; if (p2 >= 1) p2 -= 1;
        const x = tabAt(t, o0, p0) * 0.9 + tabAt(t, o0, p1) * 0.7 + sinAt(p2) * 0.9;
        const v3 = x - s2, v1 = a1 * s1 + a2 * v3, v2 = s2 + a2 * s1 + a3 * v3;
        s1 = 2 * v1 - s1; s2 = 2 * v2 - s2;
        if (st === 1) { e += aI; if (e >= pk) { e = pk; st = 2; } }
        else if (st === 2) e += dC * (su - e);
        else { e -= rC * e; if (e < 1e-5) { st = 0; break; } }
        if (gate > 0 && --gate === 0) st = 3;
        const out = v2 * e * kf; kf *= kd;
        L[i] += out * gL; R[i] += out * gR;
      }
      v.fs[0] = s1; v.fs[1] = s2; v.ph[0] = p0; v.ph[1] = p1; v.ph[2] = p2;
      v.env = e; v.stage = st; v.gate = gate; v.kf = kf; v.age += i - from;
      if (st === 0 || kf < 1e-3) v.active = false;
    }
  
    /* ── KICK: tonal glide body + held sub + harmonic + beater click, saturated.
       Writes the sidechain key.
       Row: F root Hz · P0 glide ratio · P1 glide s · P2 decay s · P3 sub · P4 click
            · P5 punch · AUX click Hz */
    function initKick(c, v, src, o, pb) {
      const sr = c.sr, S = c.sec, P = v.p;
      common(c, v, src, o, 0); v.gate = -1;
      v.kind = KIND.KICK; v.stage = 2;
      v.lvl = S[pb + PA.DRUMS] * 0.9;
      const f = v.f, dec = Math.max(0.02, src[o + EV.P2]), sub = src[o + EV.P3];
      P[0] = Math.max(0, src[o + EV.P0] - 1);
      P[1] = 1 + 0.6 * src[o + EV.P5];
      P[2] = 1 / sat(P[1]);
      P[3] = Math.max(1, 0.002 * sr); P[4] = Math.max(1, 0.004 * sr); P[5] = 0.02 * sr;
      v.inc[0] = f / sr; v.inc[1] = f / sr; v.inc[2] = (2.01 * f) / sr;
      v.lv[0] = 0.85; v.lv[1] = 0.9 * sub; v.lv[2] = 0.22 * sub + 0.08; v.lv[3] = src[o + EV.P4]; v.lv[4] = 1;
      v.dk[0] = decayOf(dec * 0.3, sr); v.dk[1] = decayOf(dec * 0.9, sr); v.dk[2] = decayOf(0.08, sr);
      v.dk[3] = decayOf(0.004, sr); v.dk[4] = decayOf(Math.max(0.003, src[o + EV.P1] / 3), sr);
      svfSet(v.cf, 0, sr, src[o + EV.AUX] || 2000, 1.1);
    }
    function rKick(c, v, L, R, from, n) {
      const P = v.p, key = c.key, lv = v.lv, dk = v.dk;
      const i0 = v.inc[0], i1 = v.inc[1], i2 = v.inc[2];
      const db = dk[0], ds = dk[1], dh = dk[2], dc = dk[3], dg = dk[4];
      const gx = P[0], drv = P[1], nrm = P[2], aB = P[3], aS = P[4], hS = P[5];
      const a1 = v.cf[0], a2 = v.cf[1], a3 = v.cf[2], kq = v.cf[3], kd = v.kd;
      const gain = v.vel * v.lvl, gL = v.gl * gain, gR = v.gr * gain;
      let p0 = v.ph[0], p1 = v.ph[1], p2 = v.ph[2], lb = lv[0], ls = lv[1], lh = lv[2], lc = lv[3], ge = lv[4];
      let s1 = v.fs[0], s2 = v.fs[1], r = v.rng | 0, age = v.age, kf = v.kf;
      for (let i = from; i < n; i++, age++) {
        ge *= dg;
        p0 += i0 * (1 + gx * ge); if (p0 >= 1) p0 -= 1;
        p1 += i1; if (p1 >= 1) p1 -= 1;
        p2 += i2; if (p2 >= 1) p2 -= 1;
        const body = sinAt(p0) * lb * (age < aB ? age / aB : 1); lb *= db;
        const sb = sinAt(p1) * ls * (age < aS ? age / aS : 1); if (age > hS) ls *= ds;
        const harm = sinAt(p2) * lh; lh *= dh;
        r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
        const x = r * NZ, v3 = x - s2, v1 = a1 * s1 + a2 * v3, v2 = s2 + a2 * s1 + a3 * v3;
        s1 = 2 * v1 - s1; s2 = 2 * v2 - s2;
        const click = v1 * kq * lc; lc *= dc;
        const y = sat((body + sb + harm + click) * drv) * nrm * kf; kf *= kd;
        const k = body + sb;
        key[i] += (k < 0 ? -k : k) * gain;
        L[i] += y * gL; R[i] += y * gR;
      }
      v.ph[0] = p0; v.ph[1] = p1; v.ph[2] = p2; lv[0] = lb; lv[1] = ls; lv[2] = lh; lv[3] = lc; lv[4] = ge;
      v.fs[0] = s1; v.fs[1] = s2; v.rng = r; v.age = age; v.kf = kf;
      if ((lb < 1e-4 && ls < 1e-4 && lh < 1e-4 && lc < 1e-4 && age > hS) || kf < 1e-3) v.active = false;
    }
  
    /* ── SNARE: tuned body + octave, band-passed noise, crack, optional rim
       Row: F body Hz · F0 noise level · P0 body level · P1 noise decay · P2 crack
            · P3 noise BP Hz · P4 body decay · P5 rim(1) · AUX crack HP Hz */
    function initSnare(c, v, src, o, pb) {
      const sr = c.sr, S = c.sec;
      common(c, v, src, o, 0); v.gate = -1;
      v.kind = KIND.SNARE; v.stage = 2;
      v.lvl = S[pb + PA.DRUMS];
      const body = src[o + EV.P0], bd = Math.max(0.005, src[o + EV.P4]);
      v.inc[0] = v.f / sr; v.inc[1] = (2 * v.f) / sr; v.inc[2] = 1700 / sr;
      v.lv[0] = body; v.lv[1] = body * 0.25; v.lv[2] = src[o + EV.F0]; v.lv[3] = src[o + EV.P2];
      v.lv[4] = src[o + EV.P5] ? 0.3 : 0; v.lv[5] = 1;
      v.dk[0] = decayOf(bd, sr); v.dk[1] = decayOf(bd * 0.7, sr); v.dk[2] = decayOf(Math.max(0.01, src[o + EV.P1]), sr);
      v.dk[3] = decayOf(0.007, sr); v.dk[4] = decayOf(0.012, sr); v.dk[5] = decayOf(0.01, sr);
      svfSet(v.cf, 0, sr, src[o + EV.P3] || 1800, 0.7);
      svfSet(v.cf, 4, sr, src[o + EV.AUX] || 5000, 0.6);
    }
    function rSnare(c, v, L, R, from, n) {
      const lv = v.lv, dk = v.dk, cf = v.cf, key = c.key;
      const A1 = cf[0], A2 = cf[1], A3 = cf[2], AK = cf[3], B1 = cf[4], B2 = cf[5], B3 = cf[6], BK = cf[7];
      const i0 = v.inc[0], i1 = v.inc[1], i2 = v.inc[2];
      const d0 = dk[0], d1 = dk[1], d2 = dk[2], d3 = dk[3], d4 = dk[4], d5 = dk[5], kd = v.kd;
      const gain = v.vel * v.lvl, gL = v.gl * gain, gR = v.gr * gain, kAmt = 0.3 * gain;
      let l0 = lv[0], l1 = lv[1], l2 = lv[2], l3 = lv[3], l4 = lv[4], pe = lv[5];
      let p0 = v.ph[0], p1 = v.ph[1], p2 = v.ph[2];
      let a1 = v.fs[0], a2 = v.fs[1], b1 = v.fs[2], b2 = v.fs[3], r = v.rng | 0, kf = v.kf;
      for (let i = from; i < n; i++) {
        pe *= d5; const bend = 1 + 0.4 * pe;
        p0 += i0 * bend; if (p0 >= 1) p0 -= 1;
        p1 += i1 * bend; if (p1 >= 1) p1 -= 1;
        let y = sinAt(p0) * l0 + sinAt(p1) * l1; l0 *= d0; l1 *= d1;
        if (l4 > 1e-5) { p2 += i2; if (p2 >= 1) p2 -= 1; y += sinAt(p2) * l4; l4 *= d4; }
        r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
        const x = r * NZ;
        let v3 = x - a2, v1 = A1 * a1 + A2 * v3, v2 = a2 + A2 * a1 + A3 * v3;
        a1 = 2 * v1 - a1; a2 = 2 * v2 - a2;
        y += v1 * AK * l2; l2 *= d2;
        v3 = x - b2; v1 = B1 * b1 + B2 * v3; v2 = b2 + B2 * b1 + B3 * v3;
        b1 = 2 * v1 - b1; b2 = 2 * v2 - b2;
        y += (x - BK * v1 - v2) * l3; l3 *= d3;
        y *= kf; kf *= kd;
        key[i] += (y < 0 ? -y : y) * kAmt;
        L[i] += y * gL; R[i] += y * gR;
      }
      lv[0] = l0; lv[1] = l1; lv[2] = l2; lv[3] = l3; lv[4] = l4; lv[5] = pe;
      v.ph[0] = p0; v.ph[1] = p1; v.ph[2] = p2;
      v.fs[0] = a1; v.fs[1] = a2; v.fs[2] = b1; v.fs[3] = b2; v.rng = r; v.kf = kf; v.age += n - from;
      if ((l0 < 1e-4 && l2 < 1e-4 && l3 < 1e-4 && l4 < 1e-4) || kf < 1e-3) v.active = false;
    }
  
    /* ── HAT / CRASH: square clusters + filtered noise
       Row: F base Hz · P0 decay tc · P1 square HP Hz · P2 noise filter Hz · P3 level
            · P4 style (0 808 · 1 metallic · 2 airy · 3 crash) · P5 square count */
    function initHat(c, v, src, o, pb) {
      const sr = c.sr, S = c.sec, P = v.p;
      common(c, v, src, o, 0); v.gate = -1;
      v.kind = KIND.HAT; v.stage = 2;
      const style = src[o + EV.P4] | 0;
      v.lvl = S[pb + PA.DRUMS] * src[o + EV.P3];
      const ratios = style === 1 ? HAT_METAL : style === 3 ? METAL : HAT_R;
      const count = style === 2 ? 0 : Math.min(6, src[o + EV.P5] | 0);
      for (let j = 0; j < count; j++) { v.inc[j] = (v.f * ratios[j]) / sr; v.ph[j] = (j * 0.137) % 1; }
      v.n = count; v.mode = style === 3 ? 2 : 1;
      P[0] = style === 2 ? 0.7 : style === 3 ? 0.12 : 0.3;
      P[1] = style === 3 ? 0.02 : 0.06;
      P[2] = 1 / Math.max(1, 0.001 * sr);
      v.lv[0] = 1; v.lv[1] = 0;
      v.dk[0] = decayOf(Math.max(0.003, src[o + EV.P0]), sr);
      svfSet(v.cf, 0, sr, src[o + EV.P1] || 7000, 0.6);
      svfSet(v.cf, 4, sr, src[o + EV.P2] || 9000, style === 3 ? 0.5 : 1.1);
    }
    function rHat(c, v, L, R, from, n) {
      const P = v.p, cf = v.cf, ph = v.ph, inc = v.inc, N = v.n;
      const A1 = cf[0], A2 = cf[1], A3 = cf[2], AK = cf[3], B1 = cf[4], B2 = cf[5], B3 = cf[6], BK = cf[7];
      const ng = P[0], sg = P[1], aI = P[2], d = v.dk[0], hp = v.mode === 2, kd = v.kd;
      const gain = v.vel * v.lvl, gL = v.gl * gain, gR = v.gr * gain;
      let e = v.lv[0], at = v.lv[1], a1 = v.fs[0], a2 = v.fs[1], b1 = v.fs[2], b2 = v.fs[3], r = v.rng | 0, kf = v.kf;
      for (let i = from; i < n; i++) {
        if (at < 1) { at += aI; if (at > 1) at = 1; }
        let y = 0;
        if (N > 0) {
          let sq = 0;
          for (let j = 0; j < N; j++) { let p = ph[j] + inc[j]; if (p >= 1) p -= 1; ph[j] = p; sq += p < 0.5 ? sg : -sg; }
          const u3 = sq - a2, u1 = A1 * a1 + A2 * u3, u2 = a2 + A2 * a1 + A3 * u3;
          a1 = 2 * u1 - a1; a2 = 2 * u2 - a2;
          y = sq - AK * u1 - u2;
        }
        r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
        const x = r * NZ, v3 = x - b2, v1 = B1 * b1 + B2 * v3, v2 = b2 + B2 * b1 + B3 * v3;
        b1 = 2 * v1 - b1; b2 = 2 * v2 - b2;
        y += (hp ? x - BK * v1 - v2 : v1 * BK) * ng;
        y *= e * at * kf; e *= d; kf *= kd;
        L[i] += y * gL; R[i] += y * gR;
      }
      v.lv[0] = e; v.lv[1] = at; v.fs[0] = a1; v.fs[1] = a2; v.fs[2] = b1; v.fs[3] = b2;
      v.rng = r; v.kf = kf; v.age += n - from;
      if (e < 1e-4 || kf < 1e-3) v.active = false;
    }
  
    /* ── TOM: a tuned membrane. Fundamental plus the (1,1) mode a major sixth-ish
       above it (×1.593), both falling into pitch, and a stick click.
       It never writes the sidechain key: a fill should not pump the music.
       Row: F Hz · P0 drop (starts at F·(1+P0)) · P1 drop s · P2 decay s · P3 stick level
            · P4 stick Hz · P5 drive 0–1 */
    function initTom(c, v, src, o, pb) {
      const sr = c.sr, S = c.sec, P = v.p;
      common(c, v, src, o, 0); v.gate = -1;
      v.kind = KIND.TOM; v.stage = 2;
      v.lvl = S[pb + PA.DRUMS] * 0.6;                         // a tom at full velocity sits level with the snare
      const f = Math.min(v.f, sr * 0.12), dec = Math.max(0.03, src[o + EV.P2]);
      P[0] = clamp(src[o + EV.P0], 0, 2);
      P[1] = 1 + 2 * clamp(src[o + EV.P5], 0, 1);
      P[2] = 1 / sat(P[1]);
      P[3] = Math.max(1, 0.0015 * sr);
      v.inc[0] = f / sr; v.inc[1] = (1.593 * f) / sr;
      v.lv[0] = 0.9; v.lv[1] = 0.28; v.lv[2] = Math.max(0, src[o + EV.P3]); v.lv[3] = 1;
      v.dk[0] = decayOf(dec, sr); v.dk[1] = decayOf(dec * 0.35, sr); v.dk[2] = decayOf(0.006, sr);
      v.dk[3] = decayOf(Math.max(0.004, src[o + EV.P1] / 3), sr);
      svfSet(v.cf, 0, sr, src[o + EV.P4] || 2400, 1.2);
    }
    function rTom(c, v, L, R, from, n) {
      const P = v.p, lv = v.lv, dk = v.dk;
      const i0 = v.inc[0], i1 = v.inc[1], db = dk[0], dv = dk[1], dc = dk[2], dg = dk[3];
      const gx = P[0], drv = P[1], nrm = P[2], aB = P[3];
      const a1 = v.cf[0], a2 = v.cf[1], a3 = v.cf[2], kq = v.cf[3], kd = v.kd;
      const gain = v.vel * v.lvl, gL = v.gl * gain, gR = v.gr * gain;
      let p0 = v.ph[0], p1 = v.ph[1], lb = lv[0], lo = lv[1], lc = lv[2], ge = lv[3];
      let s1 = v.fs[0], s2 = v.fs[1], r = v.rng | 0, age = v.age, kf = v.kf;
      for (let i = from; i < n; i++, age++) {
        ge *= dg;
        const m = 1 + gx * ge;
        p0 += i0 * m; if (p0 >= 1) p0 -= 1;
        p1 += i1 * m; if (p1 >= 1) p1 -= 1;
        let y = (sinAt(p0) * lb + sinAt(p1) * lo) * (age < aB ? age / aB : 1); lb *= db; lo *= dv;
        if (lc > 1e-5) {
          r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
          const x = r * NZ, v3 = x - s2, v1 = a1 * s1 + a2 * v3, v2 = s2 + a2 * s1 + a3 * v3;
          s1 = 2 * v1 - s1; s2 = 2 * v2 - s2;
          y += v1 * kq * lc; lc *= dc;
        }
        y = sat(y * drv) * nrm * kf; kf *= kd;
        L[i] += y * gL; R[i] += y * gR;
      }
      v.ph[0] = p0; v.ph[1] = p1; lv[0] = lb; lv[1] = lo; lv[2] = lc; lv[3] = ge;
      v.fs[0] = s1; v.fs[1] = s2; v.rng = r; v.age = age; v.kf = kf;
      if ((lb < 1e-4 && lc < 1e-4) || kf < 1e-3) v.active = false;
    }

    /* ── NOISE: filtered noise, swept F start→end over DUR
       Row: P0 mode (0 LP · 1 BP · 2 HP) · P1 Hz start · P2 Hz end · P3 Q · P4 attack s
            · P5 decay tc s · AUX shape (0 percussive · 1 swell) · VEL = peak */
    function initNoise(c, v, src, o, pb) {
      const sr = c.sr, S = c.sec, P = v.p;
      const dur = common(c, v, src, o, 0); v.gate = -1;
      v.kind = KIND.NOISE; v.stage = 3;
      v.lvl = v.bus === B_DRUMS ? S[pb + PA.DRUMS] : 1;
      v.mode = src[o + EV.P0] | 0;
      P[0] = Math.max(20, src[o + EV.P1]); P[1] = Math.max(20, src[o + EV.P2] || P[0]); P[2] = src[o + EV.P3] || 0.7;
      P[3] = 1 / Math.max(1, src[o + EV.P4] * sr);
      P[4] = decayOf(Math.max(0.002, src[o + EV.P5]), sr);
      P[5] = dur; P[6] = src[o + EV.AUX] | 0; P[7] = 1 / Math.max(1, dur * sr);
      v.lv[0] = 0; v.lv[1] = 1;
    }
    function rNoise(c, v, L, R, from, n) {
      const sr = c.sr, P = v.p;
      const k = P[5] > 0 ? Math.min(1, v.t / P[5]) : 1;
      svfSet(v.cf, 0, sr, P[0] * Math.pow(P[1] / P[0], k), P[2]);
      v.t += (n - from) / sr;
      const A1 = v.cf[0], A2 = v.cf[1], A3 = v.cf[2], AK = v.cf[3], mode = v.mode, swell = P[6] === 1;
      const aI = P[3], dec = P[4], sI = P[7], kd = v.kd;
      const gain = v.vel * v.lvl, gL = v.gl * gain, gR = v.gr * gain;
      let a = v.lv[0], ld = v.lv[1], s1 = v.fs[0], s2 = v.fs[1], r = v.rng | 0, kf = v.kf, done = false;
      for (let i = from; i < n; i++) {
        let env;
        if (swell) { a += sI; if (a >= 1) { done = true; break; } env = a < 0.98 ? a : (1 - a) * 49; }
        else { if (a < 1) { a += aI; if (a > 1) a = 1; } else ld *= dec; env = a * ld; }
        r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
        const x = r * NZ, v3 = x - s2, v1 = A1 * s1 + A2 * v3, v2 = s2 + A2 * s1 + A3 * v3;
        s1 = 2 * v1 - s1; s2 = 2 * v2 - s2;
        const y = (mode === 0 ? v2 : mode === 2 ? x - AK * v1 - v2 : v1 * AK) * env * kf; kf *= kd;
        L[i] += y * gL; R[i] += y * gR;
      }
      v.lv[0] = a; v.lv[1] = ld; v.fs[0] = s1; v.fs[1] = s2; v.rng = r; v.kf = kf; v.age += n - from;
      if (done || (!swell && a >= 1 && ld < 1e-4) || kf < 1e-3) v.active = false;
    }
  
    /* ── FIRE: the banishing. Bed + random crackles. Row: P0 crackles per second ─ */
    function initFire(c, v, src, o) {
      const sr = c.sr, P = v.p, dur = common(c, v, src, o, 0);
      v.gate = -1; v.kind = KIND.FIRE; v.stage = 3; v.lvl = 1;
      P[0] = dur; P[1] = Math.max(0, src[o + EV.P0]) / sr;
      v.lv[0] = 0; v.dk[0] = 0.99;
      svfSet(v.cf, 0, sr, 900, 0.6);
      svfSet(v.cf, 4, sr, 3000, 0.7);
    }
    function rFire(c, v, L, R, from, n) {
      const sr = c.sr, P = v.p, cf = v.cf, dt = 1 / sr, dur = P[0], prob = P[1];
      const A1 = cf[0], A2 = cf[1], A3 = cf[2], AK = cf[3];
      const gain = v.vel * v.lvl, gL = v.gl * gain, gR = v.gr * gain, kd = v.kd;
      let t = v.t, cl = v.lv[0], cd = v.dk[0], s1 = v.fs[0], s2 = v.fs[1], h1 = v.fs[2], h2 = v.fs[3];
      let r = v.rng | 0, kf = v.kf;
      for (let i = from; i < n; i++) {
        t += dt;
        const bed = t < 1 ? t * 0.05 : t < 2 ? (2 - t) * 0.05 : 0;
        r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
        const x = r * NZ;
        let v3 = x - s2, v1 = A1 * s1 + A2 * v3, v2 = s2 + A2 * s1 + A3 * v3;
        s1 = 2 * v1 - s1; s2 = 2 * v2 - s2;
        let y = v1 * AK * bed;
        if (t < dur && (x + 1) * 0.5 < prob) {
          r ^= r << 13; r ^= r >>> 17; r ^= r << 5; const u = (r >>> 0) / 4294967296;
          r ^= r << 13; r ^= r >>> 17; r ^= r << 5; const w = (r >>> 0) / 4294967296;
          cl = 0.05 + u * 0.12; cd = decayOf(0.004 + w * 0.01, sr);
          svfSet(cf, 4, sr, 1500 + w * 3000, 0.7);
        }
        if (cl > 1e-5) {
          v3 = x - h2; v1 = cf[4] * h1 + cf[5] * v3; v2 = h2 + cf[5] * h1 + cf[6] * v3;
          h1 = 2 * v1 - h1; h2 = 2 * v2 - h2;
          y += (x - cf[7] * v1 - v2) * cl; cl *= cd;
        }
        y *= kf; kf *= kd;
        L[i] += y * gL; R[i] += y * gR;
      }
      v.t = t; v.lv[0] = cl; v.dk[0] = cd; v.fs[0] = s1; v.fs[1] = s2; v.fs[2] = h1; v.fs[3] = h2;
      v.rng = r; v.kf = kf; v.age += n - from;
      if ((t > Math.max(2, dur) && cl < 1e-4) || kf < 1e-3) v.active = false;
    }
  
    const RENDER = [];
    RENDER[KIND.LEAD] = rWave; RENDER[KIND.WAVE] = rWave; RENDER[KIND.VOX] = rVox; RENDER[KIND.FM] = rFm;
    RENDER[KIND.BOW] = rBow; RENDER[KIND.BELL] = rBell; RENDER[KIND.PAD] = rPad; RENDER[KIND.DRONE] = rDrone;
    RENDER[KIND.KICK] = rKick; RENDER[KIND.SNARE] = rSnare; RENDER[KIND.HAT] = rHat;
    RENDER[KIND.NOISE] = rNoise; RENDER[KIND.FIRE] = rFire; RENDER[KIND.TOM] = rTom;
  
    /* ── §5 EFFECTS ────────────────────────────────────────────────────────── */
    /** 8-line FDN (Hadamard) + early reflections tapped from the sigil's strokes. */
    class Reverb {
      constructor(sr) {
        this.sr = sr;
        const MS = [29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.7, 73.1];
        this.len = new Int32Array(8); this.base = new Int32Array(8); this.pos = new Int32Array(8);
        let total = 0;
        for (let j = 0; j < 8; j++) { this.len[j] = Math.round((MS[j] * sr) / 1000); this.base[j] = total; total += this.len[j]; }
        this.buf = new Float32Array(total);
        this.g = new Float64Array(8); this.z = new Float64Array(8); this.y = new Float64Array(8);
        let es = 1; while (es < sr * 1.6) es <<= 1;
        this.er = new Float32Array(es); this.erM = es - 1; this.erW = 0;
        this.pre = Math.round(0.018 * sr);
        this.tD = new Int32Array(32); this.tL = new Float64Array(32); this.tR = new Float64Array(32); this.nT = 0;
        this.dc = 0.5; this.dn = 1e-20;
        this.configure(2.6, 0.55, null);
      }
      configure(rt60, damp, taps) {
        rt60 = clamp(+rt60 || 2.6, 0.3, 12);
        for (let j = 0; j < 8; j++) this.g[j] = Math.pow(10, (-3 * this.len[j]) / (rt60 * this.sr));
        this.dc = clamp(0.15 + 0.75 * (+damp || 0.5), 0.05, 0.95);
        this.nT = 0;
        if (taps) {
          for (let i = 0; i + 2 < taps.length && this.nT < 32; i += 3) {
            const d = Math.round(taps[i] * this.sr);
            if (d <= 0 || d >= this.erM) continue;
            const gain = taps[i + 1] * 0.5, pan = clamp(taps[i + 2], -1, 1), k = this.nT++;
            this.tD[k] = d; this.tL[k] = gain * (pan > 0 ? 1 - pan : 1); this.tR[k] = gain * (pan < 0 ? 1 + pan : 1);
          }
        }
      }
      clear() { this.buf.fill(0); this.er.fill(0); this.z.fill(0); }
      run(inL, inR, outL, outR, n, wet) {
        const buf = this.buf, len = this.len, base = this.base, pos = this.pos, g = this.g, z = this.z, y = this.y;
        const er = this.er, M = this.erM, pre = this.pre, nT = this.nT, tD = this.tD, tL = this.tL, tR = this.tR, dc = this.dc;
        const S8 = 0.3535533905932738;
        let w = this.erW;
        this.dn = -this.dn; const dn = this.dn;               // anti-denormal: alternating tiny DC
        for (let i = 0; i < n; i++) {
          er[w] = (inL[i] + inR[i]) * 0.5;
          let el = 0, erR = 0;
          for (let t = 0; t < nT; t++) { const s = er[(w - tD[t]) & M]; el += s * tL[t]; erR += s * tR[t]; }
          const x = er[(w - pre) & M] + dn;
          w = (w + 1) & M;
          for (let j = 0; j < 8; j++) y[j] = buf[base[j] + pos[j]];
          const a0 = y[0] + y[1], a1 = y[0] - y[1], a2 = y[2] + y[3], a3 = y[2] - y[3];
          const a4 = y[4] + y[5], a5 = y[4] - y[5], a6 = y[6] + y[7], a7 = y[6] - y[7];
          const b0 = a0 + a2, b1 = a1 + a3, b2 = a0 - a2, b3 = a1 - a3;
          const b4 = a4 + a6, b5 = a5 + a7, b6 = a4 - a6, b7 = a5 - a7;
          z[0] += dc * ((b0 + b4) * S8 + x - z[0]); z[1] += dc * ((b1 + b5) * S8 - x - z[1]);
          z[2] += dc * ((b2 + b6) * S8 + x - z[2]); z[3] += dc * ((b3 + b7) * S8 - x - z[3]);
          z[4] += dc * ((b0 - b4) * S8 + x - z[4]); z[5] += dc * ((b1 - b5) * S8 - x - z[5]);
          z[6] += dc * ((b2 - b6) * S8 + x - z[6]); z[7] += dc * ((b3 - b7) * S8 - x - z[7]);
          for (let j = 0; j < 8; j++) { buf[base[j] + pos[j]] = z[j] * g[j]; if (++pos[j] >= len[j]) pos[j] = 0; }
          outL[i] += (el + (y[0] + y[2] + y[4] + y[6]) * 0.3) * wet;
          outR[i] += (erR + (y[1] + y[3] + y[5] + y[7]) * 0.3) * wet;
        }
        this.erW = w;
      }
    }
  
    /** Tempo-synced stereo echo, LP in the feedback; slews smoothly on tempo change. */
    class Delay {
      constructor(sr) {
        this.sr = sr;
        let s = 1; while (s < sr * 3) s <<= 1;
        this.bL = new Float32Array(s); this.bR = new Float32Array(s); this.M = s - 1; this.w = 0;
        this.d = 0.45 * sr; this.dT = this.d; this.slew = 1 - Math.exp(-1 / (0.12 * sr));
        this.fb = 0.36; this.lc = 1 - Math.exp((-TAU * 2600) / sr);
        this.zl = 0; this.zr = 0; this.dn = 1e-20;
      }
      setTime(sec) { this.dT = clamp(sec * this.sr, 8, this.M - 4); }
      clear() { this.bL.fill(0); this.bR.fill(0); this.zl = 0; this.zr = 0; }
      run(inL, inR, outL, outR, revL, revR, n, ret) {
        const bL = this.bL, bR = this.bR, M = this.M, dT = this.dT, sl = this.slew, fb = this.fb, lc = this.lc, rs = ret * 0.25;
        let w = this.w, d = this.d, zl = this.zl, zr = this.zr;
        this.dn = -this.dn; const dn = this.dn;
        for (let i = 0; i < n; i++) {
          d += (dT - d) * sl;
          const rp = w - d, ip = Math.floor(rp), fr = rp - ip, i0 = ip & M, i1 = (ip + 1) & M;
          zl += lc * (bL[i0] + (bL[i1] - bL[i0]) * fr - zl) + dn;
          zr += lc * (bR[i0] + (bR[i1] - bR[i0]) * fr - zr) + dn;
          bL[w] = inL[i] + zl * fb; bR[w] = inR[i] + zr * fb;
          w = (w + 1) & M;
          outL[i] += zl * ret; outR[i] += zr * ret;
          revL[i] += zl * rs; revR[i] += zr * rs;
        }
        this.w = w; this.d = d; this.zl = zl; this.zr = zr;
      }
    }
  
    /** Two modulated taps panned ±0.7, the same shape as the old node chorus. */
    class Chorus {
      constructor(sr) {
        this.sr = sr;
        let s = 1; while (s < sr * 0.05) s <<= 1;
        this.b = new Float32Array(s); this.M = s - 1; this.w = 0;
        this.p1 = 0; this.p2 = 0.37; this.i1 = 0.23 / sr; this.i2 = 0.31 / sr;
      }
      clear() { this.b.fill(0); }
      run(inL, inR, outL, outR, n, wet) {
        const b = this.b, M = this.M, sr = this.sr, i1 = this.i1, i2 = this.i2;
        const gA = 0.972 * 0.9 * wet, gB = 0.233 * 0.9 * wet, on = wet > 1e-4;
        let w = this.w, p1 = this.p1, p2 = this.p2;
        for (let i = 0; i < n; i++) {
          b[w] = (inL[i] + inR[i]) * 0.5;
          p1 += i1; if (p1 >= 1) p1 -= 1; p2 += i2; if (p2 >= 1) p2 -= 1;
          if (on) {
            const r1 = w - (0.012 + 0.0035 * sinAt(p1)) * sr, r2 = w - (0.019 + 0.0028 * sinAt(p2)) * sr;
            const j1 = Math.floor(r1), f1 = r1 - j1, j2 = Math.floor(r2), f2 = r2 - j2;
            const a = b[j1 & M] + (b[(j1 + 1) & M] - b[j1 & M]) * f1;
            const c = b[j2 & M] + (b[(j2 + 1) & M] - b[j2 & M]) * f2;
            outL[i] += a * gA + c * gB; outR[i] += a * gB + c * gA;
          }
          w = (w + 1) & M;
        }
        this.w = w; this.p1 = p1; this.p2 = p2;
      }
    }
  
    /* ── §5b DRUM FX: the kit's own chain ──────────────────────────────────────
         drums bus → drive → shape → crush → filter ─┬→ glue ───────────┬→ master
                                                     ├→ smash (parallel)─┤
                                                     ├→ room ────────────┤
                                                     └→ echo (ping-pong)─┘
       The music has its own crusher, delay and hall; these are the kit's, so the
       drums can be destroyed without destroying the choir. Drive comes before the
       shaper so that Punch can give back the attack that saturation rounds off. Every stage is skipped
       at zero: an untouched patch costs nothing and changes nothing. Nothing here
       allocates, and coefficients move once per block.
       ────────────────────────────────────────────────────────────────────────── */

    /**
     * Transient shaper: three envelopes of one detector, compared as RATIOS so the
     * effect does not depend on how loud the kit is.
     *   fast   follows the peaks of the hit
     *   slow   chases `fast` upward with a 15 ms lag (and falls with it), so
     *          (fast − slow) / fast is large only while a hit is ARRIVING  → PUNCH
     *   peak   is pinned to `fast` at each onset and then held, so
     *          (peak − fast) / peak is how far the hit has DIED AWAY       → BODY
     * The detector is high-passed at 500 Hz (two poles): it hears clicks, noise
     * and cymbals but not the kick's sub, which would otherwise wobble the gain at
     * twice its own frequency. A dead zone ignores what ripple remains. The gain
     * is applied to the full signal, so the sub is shaped with the rest.
     */
    class Shaper {
      constructor(sr) {
        this.hc = 1 - Math.exp((-TAU * 500) / sr);
        this.fA = coefOf(0.0003, sr); this.fR = coefOf(0.06, sr);
        this.sA = coefOf(0.015, sr); this.pR = coefOf(2.5, sr);
        this.gA = coefOf(0.0004, sr); this.gR = coefOf(0.012, sr);
        this.clear();
      }
      clear() {
        this.l1 = 0; this.l2 = 0; this.r1 = 0; this.r2 = 0;
        this.eF = 0; this.eS = 0; this.eP = 0; this.ga = 0; this.gs = 0;
      }
      run(L, R, n, punch, body) {
        const hc = this.hc, fA = this.fA, fR = this.fR, sA = this.sA, pR = this.pR, gA = this.gA, gR = this.gR;
        const pa = punch >= 0 ? punch * 1.6 : punch * 0.8, ps = body >= 0 ? body * 1.8 : body * 0.92;
        let l1 = this.l1, l2 = this.l2, r1 = this.r1, r2 = this.r2;
        let eF = this.eF, eS = this.eS, eP = this.eP, ga = this.ga, gs = this.gs;
        for (let i = 0; i < n; i++) {
          const l = L[i], r = R[i];
          l1 += hc * (l - l1); let d = l - l1; l2 += hc * (d - l2); d -= l2;
          r1 += hc * (r - r1); let e = r - r1; r2 += hc * (e - r2); e -= r2;
          if (d < 0) d = -d; if (e < 0) e = -e; if (e > d) d = e;
          eF += (d > eF ? fA : fR) * (d - eF);
          if (eF > eS) eS += sA * (eF - eS); else eS = eF;
          let a = (eF - eS) / (eF + 1e-4);
          a = a > 0.2 ? (a - 0.2) * 1.25 : 0;                  // dead zone: ripple is not an onset
          if (a > 0.15 || eF > eP) eP = eF; else eP -= pR * eP;
          const t = (eP - eF) / (eP + 1e-4);
          ga += (a > ga ? gA : gR) * (a - ga);
          gs += (t < gs ? gA : gR) * (t - gs);                 // lets go at once when the next hit lands
          const g = (1 + pa * ga) * (1 + ps * gs);
          L[i] = l * g; R[i] = r * g;
        }
        const q = 1e-12;
        this.l1 = l1 > -q && l1 < q ? 0 : l1; this.l2 = l2 > -q && l2 < q ? 0 : l2;
        this.r1 = r1 > -q && r1 < q ? 0 : r1; this.r2 = r2 > -q && r2 < q ? 0 : r2;
        this.eF = eF < q ? 0 : eF; this.eS = eS < q ? 0 : eS; this.eP = eP < q ? 0 : eP;
        this.ga = ga < q ? 0 : ga; this.gs = gs < q ? 0 : gs;
      }
    }

    /** Bit-depth + sample-hold, with its own hold phase and dither stream (the kit's crusher). */
    class Crusher {
      constructor(seed) { this.seed = seed | 0 || 1; this.clear(); }
      clear() { this.n = 0; this.l = 0; this.r = 0; this.rng = this.seed; }
      run(L, R, n, mix, bits, hold) {
        const levels = Math.pow(2, bits - 1), inv = 1 / levels;
        let cn = this.n, hl = this.l, hr = this.r, r = this.rng | 0;
        for (let i = 0; i < n; i++) {
          if (cn <= 0) {
            cn = hold;
            r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
            const d = r * NZ * 0.5 * inv;
            let a = L[i], b = R[i];
            a = a < -1 ? -1 : a > 1 ? 1 : a; b = b < -1 ? -1 : b > 1 ? 1 : b;
            // round to nearest without a call: the offset keeps the operand positive, so |0 is floor
            hl = ((((a + d) * levels + 65536.5) | 0) - 65536) * inv; hr = ((((b + d) * levels + 65536.5) | 0) - 65536) * inv;
          }
          cn--;
          L[i] += (hl - L[i]) * mix; R[i] += (hr - R[i]) * mix;
        }
        this.n = cn; this.l = hl; this.r = hr; this.rng = r;
      }
    }

    /**
     * A small room for the kit: two diffusers into eight short Hadamard lines.
     * The lines are a few milliseconds long (the hall's are 30–73), so the
     * reflections arrive as one thickening of the hit rather than as echoes.
     * SIZE moves the decay and the damping, never the line lengths, so it can be
     * swept while the kit plays.
     */
    class Room {
      constructor(sr) {
        this.sr = sr;
        const MS = [5.3, 7.9, 10.1, 12.7, 15.1, 18.3, 22.9, 27.7];
        this.len = new Int32Array(8); this.base = new Int32Array(8); this.pos = new Int32Array(8);
        let total = 0;
        for (let j = 0; j < 8; j++) { this.len[j] = Math.round((MS[j] * sr) / 1000) | 1; this.base[j] = total; total += this.len[j]; }
        this.buf = new Float32Array(total);
        this.g = new Float64Array(8); this.z = new Float64Array(8); this.y = new Float64Array(8);
        let ps = 1; while (ps < sr * 0.02) ps <<= 1;
        this.pre = new Float32Array(ps); this.pM = ps - 1; this.pW = 0; this.preN = Math.round(0.006 * sr);
        this.d1 = new Float32Array(Math.round(0.0017 * sr) | 1); this.d2 = new Float32Array(Math.round(0.0031 * sr) | 1);
        this.i1 = 0; this.i2 = 0;
        this.hc = 1 - Math.exp((-TAU * 170) / sr); this.hz = 0;
        this.dc = 0.5; this.dn = 1e-20; this.size = -1; this.ring = 0;
        this.span = this.preN + this.len[7] + this.d1.length + this.d2.length;   // the longest way through, in samples
        this.setSize(0.5);
      }
      setSize(size) {
        size = clamp(+size || 0, 0, 1);
        if (Math.abs(size - this.size) < 0.004) return;
        this.size = size;
        const rt = 0.2 + 0.75 * size;
        for (let j = 0; j < 8; j++) this.g[j] = Math.pow(10, (-3 * this.len[j]) / (rt * this.sr));
        this.dc = 0.62 - 0.22 * size;                          // a bigger room is a darker one
      }
      clear() {
        this.buf.fill(0); this.pre.fill(0); this.d1.fill(0); this.d2.fill(0); this.z.fill(0);
        this.hz = 0; this.ring = 0;
      }
      /**
       * in = the dry kit; `send` scales what enters the room, `wet` what comes back. Adds into out.
       * `ring` counts down the samples until the room could be silent (see PingPong.run).
       */
      run(inL, inR, outL, outR, n, send, wet) {
        const buf = this.buf, len = this.len, base = this.base, pos = this.pos, g = this.g, z = this.z, y = this.y;
        const pre = this.pre, pM = this.pM, preN = this.preN, d1 = this.d1, d2 = this.d2, n1 = d1.length, n2 = d2.length;
        const hc = this.hc, dc = this.dc, S8 = 0.3535533905932738, s = send * 0.5;
        let w = this.pW, i1 = this.i1, i2 = this.i2, hz = this.hz, pk = 0;
        this.dn = -this.dn; const dn = this.dn;
        for (let i = 0; i < n; i++) {
          const m = (inL[i] + inR[i]) * s;
          hz += hc * (m - hz);                                 // keep the sub out of the room
          let x = m - hz;
          const qi = x < 0 ? -x : x; if (qi > pk) pk = qi;
          let d = d1[i1], a = d - 0.6 * x; d1[i1] = x + 0.6 * a; if (++i1 >= n1) i1 = 0; x = a;
          d = d2[i2]; a = d - 0.6 * x; d2[i2] = x + 0.6 * a; if (++i2 >= n2) i2 = 0;
          pre[w] = a;
          x = pre[(w - preN) & pM] + dn;
          w = (w + 1) & pM;
          for (let j = 0; j < 8; j++) y[j] = buf[base[j] + pos[j]];
          const a0 = y[0] + y[1], a1 = y[0] - y[1], a2 = y[2] + y[3], a3 = y[2] - y[3];
          const a4 = y[4] + y[5], a5 = y[4] - y[5], a6 = y[6] + y[7], a7 = y[6] - y[7];
          const b0 = a0 + a2, b1 = a1 + a3, b2 = a0 - a2, b3 = a1 - a3;
          const b4 = a4 + a6, b5 = a5 + a7, b6 = a4 - a6, b7 = a5 - a7;
          z[0] += dc * ((b0 + b4) * S8 + x - z[0]); z[1] += dc * ((b1 + b5) * S8 - x - z[1]);
          z[2] += dc * ((b2 + b6) * S8 + x - z[2]); z[3] += dc * ((b3 + b7) * S8 - x - z[3]);
          z[4] += dc * ((b0 - b4) * S8 + x - z[4]); z[5] += dc * ((b1 - b5) * S8 - x - z[5]);
          z[6] += dc * ((b2 - b6) * S8 + x - z[6]); z[7] += dc * ((b3 - b7) * S8 - x - z[7]);
          for (let j = 0; j < 8; j++) { buf[base[j] + pos[j]] = z[j] * g[j]; if (++pos[j] >= len[j]) pos[j] = 0; }
          const ol = y[0] + y[2] + y[4] + y[6], or = y[1] + y[3] + y[5] + y[7];
          outL[i] += ol * wet; outR[i] += or * wet;
          const q = ol < 0 ? -ol : ol; if (q > pk) pk = q;
        }
        this.pW = w; this.i1 = i1; this.i2 = i2; this.hz = hz > -1e-12 && hz < 1e-12 ? 0 : hz;
        if (pk > 1e-5) this.ring = this.span + n; else if (this.ring > 0) this.ring -= n;
      }
    }

    /**
     * The kit's echo: a tempo-synced ping-pong. The send is high-passed (a kick in a
     * delay line is mud), the loop is low-passed (each repeat is further away), and
     * the input enters on the left and crosses over on every repeat.
     */
    class PingPong {
      constructor(sr) {
        this.sr = sr;
        let s = 1; while (s < sr * 1.7) s <<= 1;               // one beat at 40 bpm is 1.5 s
        this.bL = new Float32Array(s); this.bR = new Float32Array(s); this.M = s - 1; this.w = 0;
        this.d = Math.round(0.45 * sr); this.dT = this.d; this.slew = 1 - Math.exp(-1 / (0.12 * sr));
        this.fb = 0.42; this.lc = 1 - Math.exp((-TAU * 3200) / sr); this.hc = 1 - Math.exp((-TAU * 320) / sr);
        this.zl = 0; this.zr = 0; this.hz = 0; this.dn = 1e-20; this.ring = 0;
      }
      /** Whole samples, so that at rest the line is read without interpolation. */
      setTime(sec) { this.dT = clamp(Math.round(sec * this.sr), 8, this.M - 4); }
      clear() { this.bL.fill(0); this.bR.fill(0); this.zl = 0; this.zr = 0; this.hz = 0; this.ring = 0; }
      /**
       * Adds the repeats into out. `ring` is how many samples remain until the line could be silent:
       * a repeat is IN FLIGHT for a whole delay time before it is heard, so silence at the output
       * does not mean the line is empty. The core rests the echo only when ring has run out.
       */
      run(inL, inR, outL, outR, n, send, ret) {
        const bL = this.bL, bR = this.bR, M = this.M, dT = this.dT, fb = this.fb, lc = this.lc, hc = this.hc;
        const s = send * 0.5;
        let w = this.w, d = this.d, zl = this.zl, zr = this.zr, hz = this.hz, pk = 0;
        this.dn = -this.dn; const dn = this.dn;
        if (d === dT) {                                        // at rest: an integer delay
          const D = dT | 0;
          for (let i = 0; i < n; i++) {
            const i0 = (w - D) & M;
            zl += lc * (bL[i0] - zl) + dn; zr += lc * (bR[i0] - zr) + dn;
            const m = (inL[i] + inR[i]) * s;
            hz += hc * (m - hz);
            const x = m - hz + zr * fb;
            bL[w] = x; bR[w] = zl * fb;
            w = (w + 1) & M;
            outL[i] += zl * ret; outR[i] += zr * ret;
            const q = x < 0 ? -x : x, u = zl < 0 ? -zl : zl;   // what went in, and what came round
            if (q > pk) pk = q; if (u > pk) pk = u;
          }
        } else {                                               // the tempo or the note value moved: glide there
          const sl = this.slew, size = M + 1;
          for (let i = 0; i < n; i++) {
            d += (dT - d) * sl;
            const rp = w - d + size, ip = rp | 0, fr = rp - ip, i0 = ip & M, i1 = (ip + 1) & M;   // rp > 0, so |0 is floor
            zl += lc * (bL[i0] + (bL[i1] - bL[i0]) * fr - zl) + dn;
            zr += lc * (bR[i0] + (bR[i1] - bR[i0]) * fr - zr) + dn;
            const m = (inL[i] + inR[i]) * s;
            hz += hc * (m - hz);
            const x = m - hz + zr * fb;
            bL[w] = x; bR[w] = zl * fb;
            w = (w + 1) & M;
            outL[i] += zl * ret; outR[i] += zr * ret;
            const q = x < 0 ? -x : x, u = zl < 0 ? -zl : zl;   // what went in, and what came round
            if (q > pk) pk = q; if (u > pk) pk = u;
          }
          if (d - dT < 0.02 && dT - d < 0.02) d = dT;         // arrived
        }
        this.w = w; this.d = d; this.zl = zl; this.zr = zr; this.hz = hz > -1e-12 && hz < 1e-12 ? 0 : hz;
        if (pk > 1e-5) this.ring = dT + n; else if (this.ring > 0) this.ring -= n;
      }
    }

    /* ── §6 CORE: transport, scheduler, voice pool, mix ───────────────────── */
    class Core {
      constructor(sr, opts) {
        opts = opts || {};
        this.sr = sr;
        this.voices = [];
        for (let i = 0; i < POOL; i++) this.voices.push(new Voice());
        this.budget = clamp(opts.voices | 0 || 48, 8, POOL - 8);
        this.order = 0; this.steals = 0; this.act = 0;
        this.killD = decayOf(0.004, sr);
        const mk = () => new Float32Array(BLOCK);
        this.bL = []; this.bR = [];
        for (let b = 0; b < NBUS; b++) { this.bL.push(mk()); this.bR.push(mk()); }
        this.used = new Uint8Array(NBUS);
        this.busG = Float64Array.from(BUS_DEFAULT); this.busT = Float64Array.from(BUS_DEFAULT);
        this.meters = new Float32Array(NBUS + 1);
        this.mL = mk(); this.mR = mk(); this.dL = mk(); this.dR = mk(); this.pL = mk(); this.pR = mk();
        this.rL = mk(); this.rR = mk(); this.yL = mk(); this.yR = mk(); this.hL = mk(); this.hR = mk();
        this.key = mk();
        this.reverb = new Reverb(sr); this.delay = new Delay(sr); this.chorus = new Chorus(sr);
        // FX state, smoothed per block
        this.choS = 0; this.echoS = 0.38; this.gritS = 0; this.foldS = 0; this.driveS = 0; this.duckS = 0;
        this.bits = 16; this.hold = 1; this.crN = 0; this.crL = 0; this.crR = 0; this.crRng = 0x1234567;
        this.revT = 0.85; this.revS = 0.85; this.mgT = 1; this.mg = 1;
        this.duckEnv = 0; this.duckG = 1; this.duckA = coefOf(0.002, sr); this.duckR = coefOf(0.12, sr);
        this.glueEnv = 0; this.glueG = 1; this.glueA = 1 - Math.exp(-BLOCK / (0.003 * sr)); this.glueR = 1 - Math.exp(-BLOCK / (0.12 * sr));
        this.compEnv = 0; this.compG = 1; this.compA = 1 - Math.exp(-BLOCK / (0.008 * sr)); this.compR = 1 - Math.exp(-BLOCK / (0.25 * sr));
        this.fxC = 1 - Math.exp(-BLOCK / (0.05 * sr)); this.lvlC = 1 - Math.exp(-BLOCK / (0.03 * sr));
        // drum FX (§5b): smoothed amounts, then each stage's state
        this.dPunchS = 0; this.dBodyS = 0; this.dDriveS = 0; this.dCrushS = 0; this.dFiltS = 0;
        this.dSmashS = 0; this.dRoomS = 0; this.dEchoS = 0; this.dBits = 16; this.dHold = 1;
        this.shaper = new Shaper(sr); this.shapeOn = false;
        this.dcrush = new Crusher(0x51f15e11);
        this.dfC = new Float64Array(4); this.dfS = new Float64Array(4); this.dfOn = false; this.dfLP = false;
        this.smEnv = 0; this.smA = coefOf(0.0002, sr); this.smR = coefOf(0.09, sr);
        this.room = new Room(sr); this.roomOn = false;
        this.decho = new PingPong(sr); this.echoOn = false;
        this.tL = mk(); this.tR = mk();
        this.dLive = 0; this.dHang = Math.ceil((0.25 * sr) / BLOCK);   // the chain rests 250 ms after the kit does
        // transport
        this.playing = false; this.beat = 0; this.bps = 1; this.total = 0; this.pass = 0; this.passMax = 0;
        this.regOn = false; this.regLo = 0; this.regHi = 0; this.ptr = 0; this.dirtyT = false;
        this.ev = new Float64Array(0); this.nEv = 0; this.sec = DEFAULT_PATCH; this.nSec = 1;
        this.blockTime = 0; this.onTransport = null; this.waveOff = 0;
        // motion (§5c): the lanes, this pass's scalars for each, and the row they are laid over
        this.au = null; this.motion = 1; this.evolve = 0; this.pass0 = 0; this.auOn = false;
        this.auD = new Float64Array(LANES); this.auM = new Float64Array(LANES); this.auS = new Float64Array(LANES);
        this.auT = new Float64Array(3); this.xr = new Float64Array(PSTRIDE); this.rowS = DEFAULT_PATCH;
        // tables
        this.cube = new Array(NCELL).fill(null); this.anyCell = null;
        this.saw = seriesTable((h) => 1 / h); this.glottal = seriesTable((h) => Math.pow(h, -1.5));
        this.c0 = this.saw; this.c1 = this.saw;
        // live notes and one-shots
        this.liveEv = new Float64Array(LIVE_MAX * STRIDE); this.liveWhen = new Float64Array(LIVE_MAX);
        this.liveId = new Int32Array(LIVE_MAX); this.nLive = 0;
        this.setBpm(100);
        if (opts.warm !== false) this.warmup();
      }
  
      /* ── time & tables ── */
      spb() { return 1 / this.bps; }
      ts() { return clamp(this.spb() / 0.6, 0.35, 1); }
      setBpm(bpm) { if (!(bpm > 0)) return; this.bps = bpm / 60; this.delay.setTime(0.75 / this.bps); }
      tier(f) { const lim = this.sr * 0.45; for (let k = 0; k < NT - 1; k++) if (TIERS[k] * f < lim) return k * TLEN1; return (NT - 1) * TLEN1; }
      cell(i) { return this.cube[i] || this.anyCell || this.saw; }
      /** The cube cells a note starts and ends on, from the section patch (same rule as m11 travel()). */
      pickCells(pb, deg, travel) {
        const S = this.sec, w = S[pb + PA.WAVE] + this.waveOff, l = S[pb + PA.LAYER];
        const x0 = ci(w, FX), y0 = ci(l, FY);
        this.c0 = this.cell(x0 + y0 * FX);
        if (!travel) { this.c1 = this.c0; return; }
        const dir = Math.round(deg) % 2 === 0 ? 1 : -1;
        this.c1 = this.cell(ci(w + S[pb + PA.SWEEP] * 4, FX) + ci(l + dir * S[pb + PA.DRIFT] * 2.5, FY) * FX);
      }
      secBase(beat) {
        const S = this.sec, N = this.nSec;
        let j = 0;
        for (let i = 1; i < N; i++) { if (beat >= S[i * PSTRIDE]) j = i; else break; }
        return j * PSTRIDE;
      }
      lower(beat) {
        const E = this.ev;
        let lo = 0, hi = this.nEv;
        while (lo < hi) { const m = (lo + hi) >> 1; if (E[m * STRIDE] < beat) lo = m + 1; else hi = m; }
        return lo;
      }

      /* ── motion (§5c) ── */
      /** Work out what this pass does to every lane. Called when the pass, the table or an amount changes, never per sample. */
      autoSet() {
        const au = this.au;
        this.auOn = false;
        if (!au) return;
        const p = this.pass + this.pass0, T = this.auT;
        for (let j = 0; j < au.n; j++) {
          autoPass(au.lanes, j, p, this.motion, this.evolve, T);
          this.auD[j] = T[0]; this.auM[j] = T[1]; this.auS[j] = T[2];
          if (T[0] !== 0 || T[2] !== 0) this.auOn = true;
        }
      }
      /**
       * The section row in force at `beat`, with this pass's motion laid over it. Sets this.rowS and
       * returns the row's offset into it. With nothing moving it hands back the plan's own table,
       * untouched, so an engine at rest reads exactly what it read before motion existed.
       */
      rowAt(beat) {
        const S = this.sec, pb = this.secBase(beat);
        if (!this.auOn) { this.rowS = S; return pb; }
        const au = this.au, L = au.lanes, X = this.xr;
        for (let i = 0; i < PSTRIDE; i++) X[i] = S[pb + i];
        for (let j = 0; j < au.n; j++) {
          const d = this.auD[j];
          const off = (d !== 0 ? autoCurve(au.curves, au.len, au.step, j, beat, this.auM[j]) * d : 0) + this.auS[j];
          if (off === 0) continue;
          const o = j * ASTRIDE, c = L[o + AU.COL] | 0;
          if (L[o + AU.GATE] > 0 && X[c] === 0) continue;
          X[c] = autoApply(X[c], off, L[o + AU.LO], L[o + AU.HI]);
        }
        this.rowS = X;
        return 0;
      }
  
      /* ── voices ── */
      /** Soft budget: over budget, the weakest voice is faded in 4 ms and a reserve slot is used. */
      alloc() {
        const V = this.voices;
        let free = null, active = 0, victim = null, best = Infinity;
        for (let i = 0; i < V.length; i++) {
          const v = V[i];
          if (!v.active) { if (free === null) free = v; continue; }
          active++;
          if (v.kd !== 1) continue;                          // already dying
          const prio = v.live ? 4e9 : v.stage === 3 ? 0 : v.kind === KIND.DRONE ? 3e9 : v.kind === KIND.PAD ? 2e9 : 1e9;
          const score = prio + v.order;
          if (score < best) { best = score; victim = v; }
        }
        if (active >= this.budget && victim) { victim.kd = this.killD; this.steals++; }
        if (free) return free;
        if (victim) { victim.active = false; this.steals++; return victim; }
        return V[0];
      }
      kill(v, tc) { const d = decayOf(tc, this.sr); if (v.kd === 1 || d < v.kd) v.kd = d; }
      releaseAll(tc, scoreOnly) {
        for (const v of this.voices) if (v.active && !(scoreOnly && v.live)) this.kill(v, tc);
      }
      noteOff(id) {
        for (const v of this.voices) {
          if (v.active && v.id === id) { if (v.stage === 1 || v.stage === 2) v.stage = 3; v.gate = -1; }
        }
        for (let i = 0; i < this.nLive; i++) if (this.liveId[i] === id) this.liveEv[i * STRIDE + EV.DUR] = 0.05;
      }
      queueLive(row, when, id) {
        if (!row || this.nLive >= LIVE_MAX) return;
        const k = this.nLive++;
        this.liveEv.set(row.subarray(0, STRIDE), k * STRIDE);
        this.liveWhen[k] = when || 0; this.liveId[k] = id || 0;
      }
      dispatchLive(n) {
        const E = this.liveEv, W = this.liveWhen, I = this.liveId;
        for (let i = 0; i < this.nLive;) {
          const off = W[i] > this.blockTime ? Math.round((W[i] - this.blockTime) * this.sr) : 0;
          if (off >= n) { i++; continue; }
          this.spawn(E, i * STRIDE, off, 0, I[i]);
          const last = --this.nLive;
          if (i !== last) { E.copyWithin(i * STRIDE, last * STRIDE, last * STRIDE + STRIDE); W[i] = W[last]; I[i] = I[last]; }
        }
      }
      /** Start a voice from row `o` of `src`, at sample `off`, `el` beats into the note. */
      spawn(src, o, off, el, id) {
        const v = this.alloc();
        v.clear();
        v.off = off; v.order = ++this.order; v.id = id | 0; v.live = src !== this.ev;
        // A note reads its patch at ITS OWN beat (not the block's), so its sound does not depend on
        // where the block boundaries fell: a live note and a rendered one are given the same row.
        const pb = this.rowAt(v.live ? this.beat : src[o]), plan = this.sec;
        this.sec = this.rowS;
        switch (src[o + EV.KIND] | 0) {
          case KIND.LEAD: initLead(this, v, src, o, pb, el); break;
          case KIND.WAVE: initWave(this, v, src, o, pb, el, src[o + EV.P0], src[o + EV.P1],
            src[o + EV.P2] || 0.32, src[o + EV.P3] === 1, src[o + EV.P4] === 1); break;
          case KIND.VOX: initVox(this, v, src, o, pb, el, src[o + EV.P3] || 1); break;
          case KIND.FM: initFm(this, v, src, o, pb, el, 1); break;
          case KIND.BOW: initBow(this, v, src, o, pb, el, 1); break;
          case KIND.BELL: initBell(this, v, src, o, pb, el, 1); break;
          case KIND.PAD: initPad(this, v, src, o, pb, el); break;
          case KIND.DRONE: initDrone(this, v, src, o, pb, el); break;
          case KIND.KICK: initKick(this, v, src, o, pb); break;
          case KIND.SNARE: initSnare(this, v, src, o, pb); break;
          case KIND.HAT: initHat(this, v, src, o, pb); break;
          case KIND.NOISE: initNoise(this, v, src, o, pb); break;
          case KIND.FIRE: initFire(this, v, src, o); break;
          case KIND.TOM: initTom(this, v, src, o, pb); break;
          default: v.active = false; this.sec = plan; return;
        }
        this.sec = plan;
        v.active = true;
      }
      /** After a seek, restart the sustained notes (pads, drones) the playhead landed inside. */
      chase(beat) {
        const E = this.ev;
        for (let i = this.lower(beat - 512); i < this.ptr; i++) {
          const o = i * STRIDE, k = E[o + EV.KIND];
          if (k !== KIND.PAD && k !== KIND.DRONE) continue;
          if (E[o] + E[o + EV.DUR] > beat + 0.25) this.spawn(E, o, 0, beat - E[o], 0);
        }
      }
      seek(beat, chase) {
        this.releaseAll(0.05, true);
        this.beat = beat; this.ptr = this.lower(beat);
        if (chase) this.chase(beat);
        this.dirtyT = true;
      }
  
      /* ── scheduler: sample-accurate dispatch, loops and regions inside a block ── */
      schedule(n) {
        const E = this.ev, bpsS = this.bps / this.sr;
        let pos = 0, guard = 0;
        while (pos < n && this.playing && guard++ < 64) {
          const reg = this.regOn, lo = reg ? this.regLo : 0, hi = reg ? this.regHi : this.total;
          const until = (hi - this.beat) / bpsS;
          if (until <= 0) { this.wrap(pos, lo, hi, reg); continue; }
          const seg = Math.min(n - pos, Math.ceil(until));
          const end = this.beat + seg * bpsS, lim = end < hi ? end : hi;
          while (this.ptr < this.nEv) {
            const o = this.ptr * STRIDE, eb = E[o];
            if (eb >= lim) break;
            this.ptr++;
            if (eb < this.beat - bpsS) continue;              // behind the playhead (after a re-plan)
            let off = pos + Math.floor((eb - this.beat) / bpsS);
            if (off < pos) off = pos; else if (off >= n) off = n - 1;
            this.spawn(E, o, off, 0, 0);
          }
          this.beat = end; pos += seg;
          if (this.beat >= hi) this.wrap(pos, lo, hi, reg);
        }
      }
      wrap(pos, lo, hi, reg) {
        if (!reg) {
          this.pass++;
          if (this.passMax > 0 && this.pass >= this.passMax) { this.beat = hi; this.playing = false; this.emitT(pos); return; }
          this.autoSet();                                     // a new pass: the lanes evolve
        }
        const span = hi - lo, over = this.beat - hi;
        this.beat = lo + (span > 0 && over > 0 ? over % span : 0);
        this.ptr = this.lower(lo);
        this.emitT(pos);
      }
      /** Publish a transport segment: "at context time t the beat was b, moving at bps". */
      emitT(pos) {
        if (!this.onTransport) return;
        const reg = this.regOn;
        this.onTransport(this.blockTime + pos / this.sr, this.beat, this.playing ? this.bps : 0,
          reg ? this.regLo : 0, reg ? this.regHi : this.total, this.pass + this.pass0, reg);
      }
  
      /* ── messages (between blocks) ── */
      command(m) {
        switch (m.type) {
          case 'plan':
            this.ev = m.events; this.nEv = m.count | 0;
            if (m.sections && m.nSec > 0) { this.sec = m.sections; this.nSec = m.nSec; }
            this.total = +m.total || 0;
            if (m.bpm) this.setBpm(m.bpm);
            if (m.passes != null) this.passMax = m.passes | 0;
            if (m.keep) this.ptr = this.lower(this.beat);
            else { this.playing = false; this.beat = 0; this.ptr = 0; this.pass = 0; this.regOn = false; }
            if (m.auto !== undefined) this.setAuto(m.auto);
            this.autoSet();
            this.dirtyT = true; break;
          case 'sections':
            if (m.nSec > 0) { this.sec = m.sections; this.nSec = m.nSec; }
            if (m.auto !== undefined) { this.setAuto(m.auto); this.autoSet(); }
            break;
          case 'auto': this.setAuto(m.auto); this.autoSet(); break;
          case 'tables':
            if (m.reset) { this.cube.fill(null); this.anyCell = null; }
            this.installCells(m.cells, m.data); break;
          case 'cube': this.buildCube(m.spectra, m.tilt || 0, m.density ?? 1); break;   // offline only
          case 'reverb': this.reverb.configure(m.rt60, m.damp, m.taps); break;
          case 'levels':
            for (const k in m.levels) {
              const b = BUS[k];
              if (b === undefined) continue;
              this.busT[b] = +m.levels[k] || 0;
              if (m.snap) this.busG[b] = this.busT[b];
            }
            break;
          case 'params':
            if (m.reverb != null) this.revT = +m.reverb;
            if (m.master != null) this.mgT = +m.master;
            if (m.waveOff != null) this.waveOff = +m.waveOff;
            if (m.voices != null) this.budget = clamp(m.voices | 0, 8, POOL - 8);
            if (m.motion != null) this.motion = Math.max(0, +m.motion || 0);
            if (m.evolve != null) this.evolve = clamp(+m.evolve || 0, 0, 1);
            if (m.pass0 != null) this.pass0 = Math.max(0, m.pass0 | 0);
            if (m.motion != null || m.evolve != null || m.pass0 != null) { this.autoSet(); this.dirtyT = true; }
            break;
          case 'play':
            this.beat = +m.beat || 0; this.pass = m.pass | 0; this.ptr = this.lower(this.beat);
            this.autoSet();
            this.playing = this.total > 0;
            if (m.chase) this.chase(this.beat);
            this.dirtyT = true; break;
          case 'stop':
            this.playing = false;
            this.releaseAll(Math.max(0.005, (m.fade ?? 0.8) / 5), false);
            this.dirtyT = true; break;
          case 'seek': this.seek(+m.beat || 0, m.chase !== false); break;
          case 'tempo': this.setBpm(m.bpm); this.dirtyT = true; break;
          case 'region': {
            const on = m.end > m.start;
            this.regOn = on; this.regLo = on ? m.start : 0; this.regHi = on ? m.end : 0;
            if (on && (this.beat < this.regLo || this.beat >= this.regHi)) this.seek(this.regLo, true);
            this.dirtyT = true; break;
          }
          case 'noteOn': this.queueLive(m.row, 0, m.id | 0); break;
          case 'noteOff': this.noteOff(m.id | 0); break;
          case 'trigger': this.queueLive(m.row, +m.when || 0, 0); break;
          case 'panic': this.panic(); break;
        }
      }
      /** Install (or clear, with null) the automation table: { n, step, len, lanes, curves }. */
      setAuto(a) {
        const ok = a && a.n > 0 && a.len > 1 && a.step > 0 && a.lanes && a.curves
          && a.lanes.length >= a.n * ASTRIDE && a.curves.length >= a.n * 2 * a.len;
        this.au = ok ? { n: Math.min(a.n | 0, LANES), step: +a.step, len: a.len | 0, lanes: a.lanes, curves: a.curves } : null;
      }
      installCells(cells, data) {
        for (let i = 0; i < cells.length; i++) {
          const c = cells[i];
          if (c < 0 || c >= NCELL) continue;
          const t = data.subarray(i * CELL, (i + 1) * CELL);
          this.cube[c] = t; this.anyCell = t;
        }
      }
      buildCube(spectra, tilt, density) {
        const data = new Float32Array(NCELL * CELL), cells = new Int16Array(NCELL);
        for (let c = 0; c < NCELL; c++) { cells[c] = c; buildCell(spectra, c, tilt, density, data, c * CELL); }
        this.installCells(cells, data);
      }
      panic() {
        for (const v of this.voices) v.active = false;
        this.nLive = 0;
        this.reverb.clear(); this.delay.clear(); this.chorus.clear();
        this.shaper.clear(); this.dcrush.clear(); this.room.clear(); this.decho.clear();
        this.dfS.fill(0); this.smEnv = 0; this.shapeOn = false; this.dfOn = false; this.roomOn = false; this.echoOn = false;
        this.dLive = 0;
        this.duckEnv = 0; this.glueEnv = 0; this.compEnv = 0; this.glueG = 1; this.compG = 1;
        this.meters.fill(0);
      }
  
      /* ── the block ── */
      process(outL, outR, n, postL, postR) {
        for (let b = 0; b < NBUS; b++) { this.bL[b].fill(0, 0, n); this.bR[b].fill(0, 0, n); }
        this.key.fill(0, 0, n);
        if (this.dirtyT) { this.dirtyT = false; this.emitT(0); }
        if (this.playing && this.total > 0) this.schedule(n);
        if (this.nLive) this.dispatchLive(n);
        const V = this.voices;
        let act = 0;
        for (let i = 0; i < V.length; i++) {
          const v = V[i];
          if (!v.active) continue;
          act++;
          this.used[v.bus] = 1;
          const fn = RENDER[v.kind];
          if (fn === undefined) { v.active = false; continue; }
          fn(this, v, this.bL[v.bus], this.bR[v.bus], v.off, n);
          v.off = 0;
        }
        this.act = act;
        this.mixdown(outL, outR, n, postL, postR);
      }
      updateFx(c) {
        const pb = this.rowAt(this.beat), S = this.rowS;
        this.choS += (S[pb + PA.CHORUS] * 0.85 - this.choS) * c;
        this.echoS += (0.2 + S[pb + PA.ECHO] * 0.6 - this.echoS) * c;
        const grit = S[pb + PA.GRIT];
        this.gritS += (grit - this.gritS) * c;
        this.bits = grit > 0 ? clamp(Math.round(S[pb + PA.BITS]), 2, 16) : 16;
        this.hold = Math.max(1, Math.round(S[pb + PA.HOLD]));
        this.foldS += (S[pb + PA.FOLD] - this.foldS) * c;
        this.driveS += (S[pb + PA.DRIVE] - this.driveS) * c;
        this.duckS += (S[pb + PA.DUCK] - this.duckS) * c;
        this.revS += (this.revT - this.revS) * c;
        this.mg += (this.mgT - this.mg) * c;
        // drum FX
        this.dPunchS += (S[pb + PA.DPUNCH] - this.dPunchS) * c;
        this.dBodyS += (S[pb + PA.DBODY] - this.dBodyS) * c;
        this.dDriveS += (S[pb + PA.DDRIVE] - this.dDriveS) * c;
        const dcr = S[pb + PA.DCRUSH];
        this.dCrushS += (dcr - this.dCrushS) * c;
        this.dBits = dcr > 0 ? clamp(Math.round(S[pb + PA.DBITS]), 2, 16) : 16;
        this.dHold = clamp(Math.round(S[pb + PA.DHOLD]), 1, 32);
        this.dFiltS += (S[pb + PA.DFILTER] - this.dFiltS) * c;
        this.dSmashS += (S[pb + PA.DSMASH] - this.dSmashS) * c;
        this.dRoomS += (S[pb + PA.DROOM] - this.dRoomS) * c;
        this.dEchoS += (S[pb + PA.DECHO] - this.dEchoS) * c;
        this.room.setSize(S[pb + PA.DSIZE]);
        const dt = S[pb + PA.DTIME];
        this.decho.setTime((dt > 0 ? dt : 0.75) / this.bps);
      }
      snapFx() { this.updateFx(1); this.busG.set(this.busT); this.decho.d = this.decho.dT; }
      mixdown(outL, outR, n, postL, postR) {
        const mL = this.mL, mR = this.mR, dL = this.dL, dR = this.dR, pL = this.pL, pR = this.pR;
        const rL = this.rL, rR = this.rR, yL = this.yL, yR = this.yR, hL = this.hL, hR = this.hR;
        mL.fill(0, 0, n); mR.fill(0, 0, n); dL.fill(0, 0, n); dR.fill(0, 0, n); pL.fill(0, 0, n); pR.fill(0, 0, n);
        rL.fill(0, 0, n); rR.fill(0, 0, n); yL.fill(0, 0, n); yR.fill(0, 0, n); hL.fill(0, 0, n); hR.fill(0, 0, n);
        this.updateFx(this.fxC);
        if (this.used[B_DRUMS]) this.dLive = this.dHang; else if (this.dLive > 0) this.dLive--;
        // 1 · buses → music / drums / post, plus sends
        for (let b = 0; b < NBUS; b++) {
          let g = this.busG[b];
          const g1 = g + (this.busT[b] - g) * this.lvlC;
          this.busG[b] = g1;
          if (!this.used[b]) continue;
          this.used[b] = 0;
          const dg = (g1 - g) / n, L = this.bL[b], R = this.bR[b];
          const sRv = SEND_REV[b], sDl = SEND_DLY[b], sCh = SEND_CHO[b];
          const toL = b === B_DRUMS ? dL : b === B_POST ? pL : mL, toR = b === B_DRUMS ? dR : b === B_POST ? pR : mR;
          let pk = this.meters[b];
          for (let i = 0; i < n; i++) {
            g += dg;
            const l = L[i] * g, r = R[i] * g;
            toL[i] += l; toR[i] += r;
            if (sRv !== 0) { rL[i] += l * sRv; rR[i] += r * sRv; }
            if (sDl !== 0) { yL[i] += l * sDl; yR[i] += r * sDl; }
            if (sCh !== 0) { hL[i] += l * sCh; hR[i] += r * sCh; }
            const a = l < 0 ? -l : l, c = r < 0 ? -r : r;
            if (a > pk) pk = a; if (c > pk) pk = c;
          }
          this.meters[b] = pk;
        }
        // 2 · music FX: chorus → delay (bleeds into the hall) → reverb
        this.chorus.run(hL, hR, mL, mR, n, this.choS);
        this.delay.run(yL, yR, mL, mR, rL, rR, n, this.echoS);
        this.reverb.run(rL, rR, mL, mR, n, this.revS * REV_GAIN);
        // 3 · sidechain: an envelope follower on the kick key, not a scheduled dip
        if (this.duckS > 0.001 || this.duckEnv > 1e-6) {
          const key = this.key, ka = this.duckA, kr = this.duckR, depth = this.duckS;
          let e = this.duckEnv, gg = 1;
          for (let i = 0; i < n; i++) {
            const k = key[i];
            e += (k > e ? ka : kr) * (k - e);
            const q = e * 2.2;
            gg = 1 - (q > 1 ? 1 : q) * depth;
            mL[i] *= gg; mR[i] *= gg;
          }
          this.duckEnv = e < 1e-7 ? 0 : e; this.duckG = gg;
        }
        // 4 · crusher (music only, so the kit stays clean)
        if (this.gritS > 0.001) this.crush(mL, mR, n);
        // 5 · the kit's own chain (§5b), around the glue: 4:1 above −14 dB, detected per block
        this.drumFx(dL, dR, n);
        // 6 · master
        this.master(outL, outR, n, postL, postR);
      }
      crush(L, R, n) {
        const mix = this.gritS, levels = Math.pow(2, this.bits - 1), inv = 1 / levels, hold = this.hold;
        const drive = this.driveS, fold = this.foldS, k = 1 + drive * 5, nrm = drive > 0.001 ? 1 / sat(k) : 1;
        const fk = Math.PI * 0.5 * (1 + 3 * fold), useD = drive > 0.001, useF = fold > 0.001;
        let cn = this.crN, hl = this.crL, hr = this.crR, r = this.crRng | 0;
        for (let i = 0; i < n; i++) {
          if (cn <= 0) {
            cn = hold;
            r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
            const d = r * NZ * 0.5 * inv;
            let a = useD ? sat(L[i] * k) * nrm : L[i], b = useD ? sat(R[i] * k) * nrm : R[i];
            if (useF) { a = (1 - fold) * a + fold * Math.sin(a * fk); b = (1 - fold) * b + fold * Math.sin(b * fk); }
            a = a < -1 ? -1 : a > 1 ? 1 : a; b = b < -1 ? -1 : b > 1 ? 1 : b;
            hl = Math.round((a + d) * levels) * inv; hr = Math.round((b + d) * levels) * inv;
          }
          cn--;
          L[i] += (hl - L[i]) * mix; R[i] += (hr - R[i]) * mix;
        }
        this.crN = cn; this.crL = hl; this.crR = hr; this.crRng = r;
      }
      /**
       * §5b in order. Each stage is skipped at zero, so a default patch reaches glue() untouched;
       * and the whole chain rests while the kit is silent (a section without drums costs nothing).
       */
      drumFx(L, R, n) {
        const EPS = 0.002, live = this.dLive > 0;
        const pu = this.dPunchS, bo = this.dBodyS, fl = this.dFiltS;
        if (live) {
          if (this.dDriveS > EPS) this.drumDrive(L, R, n, this.dDriveS);
          if (pu > EPS || pu < -EPS || bo > EPS || bo < -EPS) { this.shaper.run(L, R, n, pu, bo); this.shapeOn = true; }
          else if (this.shapeOn) { this.shaper.clear(); this.shapeOn = false; }
          if (this.dCrushS > EPS) this.dcrush.run(L, R, n, this.dCrushS > 1 ? 1 : this.dCrushS, this.dBits, this.dHold);
          if (fl > EPS || fl < -EPS) this.drumFilter(L, R, n, fl);
          else if (this.dfOn) { this.dfS.fill(0); this.dfOn = false; }
        } else {
          if (this.shapeOn) { this.shaper.clear(); this.shapeOn = false; }
          if (this.dfOn) { this.dfS.fill(0); this.dfOn = false; }
        }
        // sends are taken after the tone stages and before the glue, so tails are not pumped
        const sm = live && this.dSmashS > EPS;
        const rm = this.roomOn || (live && this.dRoomS > EPS), ec = this.echoOn || (live && this.dEchoS > EPS);
        const tL = this.tL, tR = this.tR;
        if (sm || rm || ec) for (let i = 0; i < n; i++) { tL[i] = L[i]; tR[i] = R[i]; }
        this.glue(L, R, n);
        if (sm) this.smash(tL, tR, L, R, n, this.dSmashS);
        else this.smEnv = 0;
        if (rm) {
          const a = live && this.dRoomS > EPS ? this.dRoomS : 0;
          this.room.run(tL, tR, L, R, n, a, 0.5);
          this.roomOn = a > 0 || this.room.ring > 0;           // ring out, then rest
          if (!this.roomOn) this.room.clear();
        }
        if (ec) {
          const a = live && this.dEchoS > EPS ? this.dEchoS : 0;
          this.decho.run(tL, tR, L, R, n, a, 0.9);
          this.echoOn = a > 0 || this.decho.ring > 0;
          if (!this.echoOn) this.decho.clear();
        }
      }
      /**
       * Saturation that is unity at the kit's working level (0.28): louder hits are rounded off,
       * quieter ones come up to meet them. It thickens the kit rather than merely turning it up.
       */
      drumDrive(L, R, n, amt) {
        const k = 1 + amt * 5, nrm = 0.28 / sat(0.28 * k), w = amt < 0.1 ? amt * 10 : 1;
        for (let i = 0; i < n; i++) {
          const l = L[i], r = R[i];
          L[i] = l + (sat(l * k) * nrm - l) * w; R[i] = r + (sat(r * k) * nrm - r) * w;
        }
      }
      /** One knob: below zero a low-pass closes from 20 kHz to 120 Hz, above zero a high-pass opens from 20 Hz to 6 kHz. */
      drumFilter(L, R, n, f) {
        const lp = f < 0, a = lp ? (f < -1 ? 1 : -f) : (f > 1 ? 1 : f), cf = this.dfC, st = this.dfS;
        if (!this.dfOn || lp !== this.dfLP) {                  // entering, or crossing zero: start from a state
          st[0] = 0; st[2] = 0;                                // that passes the signal, so there is no tick
          st[1] = lp ? L[0] : 0; st[3] = lp ? R[0] : 0;
          this.dfLP = lp;
        }
        svfSet(cf, 0, this.sr, lp ? 20000 * Math.pow(0.006, a) : 20 * Math.pow(300, a), 0.75 + 0.55 * a);
        const a1 = cf[0], a2 = cf[1], a3 = cf[2], k = cf[3];
        let l1 = st[0], l2 = st[1], r1 = st[2], r2 = st[3];
        for (let i = 0; i < n; i++) {
          let x = L[i], v3 = x - l2, v1 = a1 * l1 + a2 * v3, v2 = l2 + a2 * l1 + a3 * v3;
          l1 = 2 * v1 - l1; l2 = 2 * v2 - l2;
          L[i] = lp ? v2 : x - k * v1 - v2;
          x = R[i]; v3 = x - r2; v1 = a1 * r1 + a2 * v3; v2 = r2 + a2 * r1 + a3 * v3;
          r1 = 2 * v1 - r1; r2 = 2 * v2 - r2;
          R[i] = lp ? v2 : x - k * v1 - v2;
        }
        const t = 1e-15;
        st[0] = l1 > -t && l1 < t ? 0 : l1; st[1] = l2 > -t && l2 < t ? 0 : l2;
        st[2] = r1 > -t && r1 < t ? 0 : r1; st[3] = r2 > -t && r2 < t ? 0 : r2;
        this.dfOn = true;
      }
      /**
       * Parallel compression: a hard-squashed copy (12:1 above −29 dB, +8 dB make-up) added under
       * the kit, and the sum trimmed so that a full-level hit leaves as loud as it arrived. Peaks
       * stay where they were; everything between them comes up. Weight without losing the hit.
       */
      smash(inL, inR, outL, outR, n, amt) {
        const A = this.smA, Rl = this.smR, thr = 0.035, add = amt * 2.6, trim = 1 / (1 + 0.38 * amt);
        let e = this.smEnv;
        for (let i = 0; i < n; i++) {
          const l = inL[i], r = inR[i];
          let a = l < 0 ? -l : l; const b = r < 0 ? -r : r; if (b > a) a = b;
          e += (a > e ? A : Rl) * (a - e);
          const g = (e > thr ? (thr + (e - thr) * 0.0833) / e : 1) * add;
          outL[i] = (outL[i] + l * g) * trim; outR[i] = (outR[i] + r * g) * trim;
        }
        this.smEnv = e < 1e-9 ? 0 : e;
      }
      glue(L, R, n) {
        let pk = 0;
        for (let i = 0; i < n; i++) {
          const a = L[i] < 0 ? -L[i] : L[i], b = R[i] < 0 ? -R[i] : R[i];
          if (a > pk) pk = a; if (b > pk) pk = b;
        }
        this.glueEnv += (pk > this.glueEnv ? this.glueA : this.glueR) * (pk - this.glueEnv);
        if (this.glueEnv < 1e-9) this.glueEnv = 0;
        const e = this.glueEnv, thr = 0.2, tg = e > thr ? (thr + (e - thr) / 4) / e : 1;
        let g = this.glueG; const dg = (tg - g) / n;
        for (let i = 0; i < n; i++) { g += dg; L[i] *= g; R[i] *= g; }
        this.glueG = tg;
      }
      master(outL, outR, n, postL, postR) {
        const mL = this.mL, mR = this.mR, dL = this.dL, dR = this.dR, pL = this.pL, pR = this.pR, mg = this.mg;
        let pk = 0;
        for (let i = 0; i < n; i++) {
          const l = (mL[i] + dL[i]) * mg, r = (mR[i] + dR[i]) * mg;
          mL[i] = l; mR[i] = r;
          const a = l < 0 ? -l : l, b = r < 0 ? -r : r;
          if (a > pk) pk = a; if (b > pk) pk = b;
        }
        // bus compressor: 3:1 above −16 dB, 8 ms / 250 ms, then a soft limiter
        this.compEnv += (pk > this.compEnv ? this.compA : this.compR) * (pk - this.compEnv);
        if (this.compEnv < 1e-9) this.compEnv = 0;
        const e = this.compEnv, thr = 0.158, tg = e > thr ? (thr + (e - thr) / 3) / e : 1;
        let g = this.compG; const dg = (tg - g) / n, post = !!postL;
        for (let i = 0; i < n; i++) {
          g += dg;
          let l = sat(mL[i] * g * MAKEUP), r = sat(mR[i] * g * MAKEUP);
          if (post) { postL[i] = sat(pL[i]); postR[i] = sat(pR[i]); }
          else { l += pL[i]; r += pR[i]; }
          outL[i] = l; outR[i] = r;
        }
        this.compG = tg;
        const m = pk * tg * MAKEUP;
        if (m > this.meters[NBUS]) this.meters[NBUS] = m;
      }
      tickInfo(t, load) {
        const m = this.meters, meters = new Array(m.length);
        for (let i = 0; i < m.length; i++) { meters[i] = m[i]; m[i] = 0; }
        // What each lane adds right now (column units): lets the page check that it and the core agree.
        let moved = null;
        if (this.auOn) {
          const au = this.au;
          moved = new Array(au.n);
          for (let j = 0; j < au.n; j++) {
            moved[j] = (this.auD[j] !== 0 ? autoCurve(au.curves, au.len, au.step, j, this.beat, this.auM[j]) * this.auD[j] : 0) + this.auS[j];
          }
        }
        return { type: 'tick', t, beat: this.beat, pass: this.pass + this.pass0, playing: this.playing, voices: this.act,
          budget: this.budget, steals: this.steals, duck: this.duckG, load, meters, moved };
      }
      /** Run every voice kind briefly so the JIT compiles the hot loops before the first note. */
      warmup() {
        const row = new Float64Array(STRIDE), sL = new Float32Array(BLOCK), sR = new Float32Array(BLOCK);
        row[EV.F] = 220; row[EV.DUR] = 0.5; row[EV.VEL] = 0.3; row[EV.AUX] = 2000;
        row[EV.P0] = 1.5; row[EV.P1] = 0.05; row[EV.P2] = 0.3; row[EV.P3] = 1; row[EV.P4] = 1; row[EV.P5] = 4; row[EV.SEED] = 7;
        const kinds = [KIND.LEAD, KIND.WAVE, KIND.VOX, KIND.FM, KIND.BOW, KIND.BELL, KIND.PAD, KIND.DRONE,
          KIND.KICK, KIND.SNARE, KIND.HAT, KIND.NOISE, KIND.FIRE, KIND.TOM];
        for (let rep = 0; rep < 3; rep++) {
          for (const k of kinds) { row[EV.KIND] = k; row[EV.BUS] = k >= KIND.KICK ? B_DRUMS : 0; this.spawn(row, 0, 0, 0, 0); }
          for (let b = 0; b < 16; b++) this.process(sL, sR, BLOCK);
        }
        this.panic();
        this.order = 0; this.steals = 0;
      }
    }
  
    /* ── §7 OFFLINE: render a time range of a job (Worker and Node bench share this) ── */
    function renderRange(job, from, to, keep, onProgress) {
      const sr = job.sr, core = new Core(sr, { voices: job.voices || 80, warm: false });
      core.command({ type: 'cube', spectra: job.spectra, tilt: job.tilt, density: job.density });
      if (job.reverb) core.command({ type: 'reverb', rt60: job.reverb.rt60, damp: job.reverb.damp, taps: job.reverb.taps });
      core.command({ type: 'plan', events: job.events, count: job.count, sections: job.sections, nSec: job.nSec,
        total: job.total, bpm: job.bpm, passes: job.passes, auto: job.auto || null });
      core.command({ type: 'levels', levels: job.levels || {}, snap: true });
      core.command(Object.assign({ type: 'params' }, job.params || {}));
      const spb = 60 / job.bpm, passSec = job.total * spb, pass = Math.floor(from / passSec + 1e-9);
      if (pass < job.passes) core.command({ type: 'play', beat: (from - pass * passSec) / spb, pass, chase: true });
      core.snapFx();
      const frames = Math.max(0, Math.round((to - from) * sr)), skip = Math.round((keep - from) * sr);
      const L = new Float32Array(Math.max(0, frames - skip)), R = new Float32Array(L.length);
      const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
      let next = sr;
      for (let pos = 0; pos < frames; pos += BLOCK) {
        core.blockTime = pos / sr;
        core.process(bl, br, BLOCK);
        for (let i = 0; i < BLOCK; i++) {
          const j = pos + i - skip;
          if (j >= 0 && j < L.length) { L[j] = bl[i]; R[j] = br[i]; }
        }
        if (onProgress && pos >= next) { next += sr; onProgress(pos / frames); }
      }
      return { L, R };
    }
  
    G.SigilDSP = Object.freeze({
      VERSION, BLOCK, TLEN, TLEN1, TIERS, NT, CELL, H, UPPER, FX, FY, NCELL,
      KIND, BUS, BUS_NAMES, BUS_DEFAULT, EV, STRIDE, PA, PSTRIDE, DEFAULT_PATCH,
      AU, ASTRIDE, LANES, autoPass, autoCurve, autoApply, autoTrend, hash01,
      Core, buildTables, buildCell, renderRange,
    });
  })(typeof globalThis !== 'undefined' ? globalThis : self);